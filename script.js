/**
 * 逻辑链条蓝图编辑器 - script.js
 * UE蓝图风格：节点可拖拽，Pin 拖拽连线，画布平移/缩放
 */

/* ═══════════════════════════════════════════════════════
   工具：生成唯一 ID
═══════════════════════════════════════════════════════ */
let _uid = 0;
function uid() { return 'n' + (++_uid); }

/* ═══════════════════════════════════════════════════════
   撤销历史辅助：深拷贝简单对象
═══════════════════════════════════════════════════════ */
function cloneSimple(obj) { return JSON.parse(JSON.stringify(obj)); }

/* ═══════════════════════════════════════════════════════
   BlueprintEditor 主类
═══════════════════════════════════════════════════════ */
class BlueprintEditor {
    constructor() {
        /* ── DOM 引用 ── */
        this.container   = document.getElementById('canvasContainer');
        this.nodeLayer   = document.getElementById('nodeLayer');
        this.svgGroup    = document.getElementById('svgGroup');
        this.svgLayer    = document.getElementById('svgLayer');

        /* ── 视口状态 ── */
        this.panX  = 0;
        this.panY  = 0;
        this.zoom  = 1;

        /* ── 节点/连接数据 ── */
        this.nodes       = {};   // id -> { id, x, y, w, title, content, completed, type, el }
        this.connections = {};   // id -> { id, fromId, toId, path }

        /* ── 分组数据 ── */
        this.groups      = {};   // id -> { id, label, color, nodeIds:Set, x, y, w, h, el }

        /* ── 拖拽 & 连线状态 ── */
        this.dragging    = null; // { nodeId, startMouseX, startMouseY, startNodeX, startNodeY }
        this.isPanning   = false;
        this.panStart    = null;

        this.isConnecting    = false;
        this.connFrom        = null; // nodeId
        this.connTempPath    = null; // SVGPathElement

        /* ── 节点 Resize 状态 ── */
        // { nodeId, dir, startMouseX, startMouseY, startX, startY, startW, startH }
        this.resizing    = null;

        /* ── 框选状态 ── */
        this.isSelecting    = false;   // 是否正在框选
        this.selectRect     = null;    // 框选矩形 DOM
        this.selectStart    = null;    // 框选起点 { x, y }（屏幕坐标）
        this.selectedNodes  = new Set(); // 当前框选中的节点 id

        /* ── 分组拖拽状态 ── */
        this.draggingGroup  = null;    // { groupId, startMouseX, startMouseY, startX, startY, memberSnaps }

        /* ── 编辑状态 ── */
        this.editingNodeId   = null;

        /* ── 选中连线 ── */
        this.selectedConnId  = null;   // 当前选中的连线 id

        /* ── 撤销历史栈 ── */
        // 每条记录：{ type, ...payload }
        this.undoStack  = [];
        this.MAX_UNDO   = 60;

        /* ── 全局颜色配置 ── */
        this.colorConfig = {
            canvasBg:   '#f7f8fa',   // 画布背景色（浅灰）
            nodeBg:     null,        // null = 使用 CSS 变量（白色）
            nodeHeader: null,        // null = 使用 CSS 变量（浅灰）
        };
        this._loadColorConfig(); // 从 localStorage 恢复

        this._initTransform();
        this._bindEvents();
        this._bindToolbar();
        this._bindModelSelect();
        this._bindModals();
        this._bindImageDrop();
        this._bindUndoKey();
        this._bindGroupPopup();
        this._bindColorPalette();
        this._bindContextMenu();
        this._bindRichToolbar();

        // 演示节点
        this._addDemoNodes();
    }

    /* ════════════════════════════════════════════════════
       TRANSFORM：统一缩放 nodeLayer + svgGroup
    ════════════════════════════════════════════════════ */
    _initTransform() {
        this._applyTransform();
    }

    _applyTransform() {
        const t = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
        this.nodeLayer.style.transform        = t;
        this.nodeLayer.style.transformOrigin  = '0 0';
        this.svgGroup.setAttribute('transform',
            `translate(${this.panX} ${this.panY}) scale(${this.zoom})`);
        // 更新缩放显示
        const disp = document.getElementById('zoomDisplay');
        if (disp) disp.textContent = Math.round(this.zoom * 100) + '%';
        const slider = document.getElementById('zoomSlider');
        if (slider) slider.value = Math.round(this.zoom * 100);
    }

    /* ── 屏幕坐标 → 画布内坐标 ── */
    _toCanvas(sx, sy) {
        const r = this.container.getBoundingClientRect();
        return {
            x: (sx - r.left - this.panX) / this.zoom,
            y: (sy - r.top  - this.panY) / this.zoom,
        };
    }

    /* ════════════════════════════════════════════════════
       PIN 中心：计算节点 Pin 在画布坐标中的位置
    ════════════════════════════════════════════════════ */
    _getPinPos(nodeId, type) {
        const nd = this.nodes[nodeId];
        if (!nd) return { x:0, y:0 };
        const h = nd.el.offsetHeight;
        const w = nd.el.offsetWidth;
        if (type === 'output') return { x: nd.x + w,     y: nd.y + h / 2 };
        else                   return { x: nd.x,          y: nd.y + h / 2 };
    }

    /* ════════════════════════════════════════════════════
       BEZIER 路径
    ════════════════════════════════════════════════════ */
    _bezierPath(x1, y1, x2, y2) {
        const c = Math.min(Math.abs(x2 - x1) * 0.6 + 40, 300);
        return `M ${x1} ${y1} C ${x1+c} ${y1}, ${x2-c} ${y2}, ${x2} ${y2}`;
    }

    /* ════════════════════════════════════════════════════
       EVENTS
    ════════════════════════════════════════════════════ */
    _bindEvents() {
        const c = this.container;
        c.addEventListener('mousedown',  e => this._onMouseDown(e));
        window.addEventListener('mousemove', e => this._onMouseMove(e));
        window.addEventListener('mouseup',   e => this._onMouseUp(e));
        c.addEventListener('wheel', e => this._onWheel(e), { passive:false });

        // 防止右键出现默认菜单（将来可做上下文菜单）
        c.addEventListener('contextmenu', e => e.preventDefault());
    }

    _onMouseDown(e) {
        // ── Word 行为：点击可编辑区以外时，让当前编辑区失焦（保存内容） ──
        const clickedEditable = e.target.closest?.('.node-title, .node-text');
        if (!clickedEditable && document.activeElement?.isContentEditable) {
            document.activeElement.blur();
        }

        const onCanvas = e.target === this.container || e.target === this.svgLayer
                      || e.target === this.nodeLayer;

        // ── 中键：画布平移 ──
        if (e.button === 1) {
            e.preventDefault();
            this.isPanning = true;
            this.panStart  = { x: e.clientX - this.panX, y: e.clientY - this.panY };
            this.container.classList.add('panning');
            return;
        }

        // ── 左键 + 画布背景：框选，同时取消连线选中 ──
        if (e.button === 0 && onCanvas && !this.isConnecting) {
            this._deselectConn();
            this.isSelecting  = true;
            this.selectStart  = { x: e.clientX, y: e.clientY };
            this.selectedNodes.clear();

            // 创建框选矩形 DOM（屏幕坐标，叠在最上层）
            const rect = document.createElement('div');
            rect.className = 'select-rect';
            rect.style.cssText = `left:${e.clientX}px; top:${e.clientY}px; width:0; height:0;`;
            document.body.appendChild(rect);
            this.selectRect = rect;
        }
    }

    _onMouseMove(e) {
        // ── 画布平移（中键）──
        if (this.isPanning && !this.isConnecting && !this.dragging && !this.resizing) {
            this.panX = e.clientX - this.panStart.x;
            this.panY = e.clientY - this.panStart.y;
            this._applyTransform();
            this._redrawAllConnections();
        }

        // ── 框选矩形更新 ──
        if (this.isSelecting && this.selectRect && this.selectStart) {
            const x1 = this.selectStart.x, y1 = this.selectStart.y;
            const x2 = e.clientX,          y2 = e.clientY;
            const left   = Math.min(x1, x2);
            const top    = Math.min(y1, y2);
            const width  = Math.abs(x2 - x1);
            const height = Math.abs(y2 - y1);
            this.selectRect.style.left   = left   + 'px';
            this.selectRect.style.top    = top    + 'px';
            this.selectRect.style.width  = width  + 'px';
            this.selectRect.style.height = height + 'px';

            // 实时高亮命中的节点
            const selBox = { left, top, right: left + width, bottom: top + height };
            this.selectedNodes.clear();
            Object.values(this.nodes).forEach(nd => {
                const r = this.container.getBoundingClientRect();
                const nx = nd.x * this.zoom + this.panX + r.left;
                const ny = nd.y * this.zoom + this.panY + r.top;
                const nw = (nd.el.offsetWidth)  * this.zoom;
                const nh = (nd.el.offsetHeight) * this.zoom;
                // 节点矩形与框选矩形相交即选中
                if (nx < selBox.right && nx + nw > selBox.left &&
                    ny < selBox.bottom && ny + nh > selBox.top) {
                    this.selectedNodes.add(nd.id);
                }
            });
            // 更新节点高亮视觉
            Object.values(this.nodes).forEach(nd => {
                nd.el.classList.toggle('box-selected', this.selectedNodes.has(nd.id));
            });
        }

        // ── 分组整体拖拽 ──
        if (this.draggingGroup) {
            const dg = this.draggingGroup;
            const dx = (e.clientX - dg.startMouseX) / this.zoom;
            const dy = (e.clientY - dg.startMouseY) / this.zoom;
            const grp = this.groups[dg.groupId];
            if (!grp) return;
            // 移动分组框
            grp.x = dg.startX + dx;
            grp.y = dg.startY + dy;
            grp.el.style.left = grp.x + 'px';
            grp.el.style.top  = grp.y + 'px';
            // 同步移动所有成员节点
            dg.memberSnaps.forEach(({ id, ox, oy }) => {
                const nd = this.nodes[id];
                if (!nd) return;
                nd.x = ox + dx;
                nd.y = oy + dy;
                nd.el.style.left = nd.x + 'px';
                nd.el.style.top  = nd.y + 'px';
                this._redrawConnections(id);
            });
        }

        // ── 节点拖拽 ──
        if (this.dragging) {
            const nd = this.nodes[this.dragging.id];
            if (!nd) return;
            const dx = (e.clientX - this.dragging.startMouseX) / this.zoom;
            const dy = (e.clientY - this.dragging.startMouseY) / this.zoom;
            nd.x = this.dragging.startNodeX + dx;
            nd.y = this.dragging.startNodeY + dy;
            nd.el.style.left = nd.x + 'px';
            nd.el.style.top  = nd.y + 'px';
            this._redrawConnections(nd.id);
        }

        // ── 连线拖拽（含磁吸吸附）──
        if (this.isConnecting && this.connTempPath) {
            const from = this._getPinPos(this.connFrom, 'output');
            const SNAP_RADIUS = 60; // 屏幕像素吸附半径

            // 找距离最近的 input-pin（排除自身节点）
            let snapPin = null;
            let snapDist = Infinity;
            document.querySelectorAll('.input-pin').forEach(p => {
                if (p.dataset.nodeId === this.connFrom) return;
                const rect = p.getBoundingClientRect();
                const cx = rect.left + rect.width  / 2;
                const cy = rect.top  + rect.height / 2;
                const dist = Math.hypot(e.clientX - cx, e.clientY - cy);
                if (dist < SNAP_RADIUS && dist < snapDist) {
                    snapDist = dist;
                    snapPin  = p;
                }
            });

            // 更新所有 pin 的 connectable 状态
            document.querySelectorAll('.input-pin').forEach(p => p.classList.remove('connectable', 'snap-target'));
            this.connSnapTarget = null;

            let endCanvas;
            if (snapPin) {
                snapPin.classList.add('connectable', 'snap-target');
                this.connSnapTarget = snapPin.dataset.nodeId;
                // 吸附：让临时线末端指向该 pin 的精确中心（canvas 坐标）
                endCanvas = this._getPinPos(this.connSnapTarget, 'input');
            } else {
                endCanvas = this._toCanvas(e.clientX, e.clientY);
            }
            this.connTempPath.setAttribute('d', this._bezierPath(from.x, from.y, endCanvas.x, endCanvas.y));
        }

        // ── 节点 Resize ──
        if (this.resizing) {
            const rs = this.resizing;
            const nd = this.nodes[rs.id];
            if (!nd) return;

            // 鼠标移动量转换到画布坐标（考虑 zoom）
            const dxS = (e.clientX - rs.startMouseX) / this.zoom;
            const dyS = (e.clientY - rs.startMouseY) / this.zoom;

            const MIN_W = 140;
            const MIN_H = 60;

            const dir = rs.dir;

            // 计算新的宽高和位置
            let newX = rs.startX;
            let newY = rs.startY;
            let newW = rs.startW;
            let newH = rs.startH;

            // 东（右边）方向：宽增大，x 不变
            if (dir.includes('e')) newW = Math.max(MIN_W, rs.startW + dxS);
            // 西（左边）方向：宽增大，x 减小
            if (dir.includes('w')) {
                newW = Math.max(MIN_W, rs.startW - dxS);
                newX = rs.startX + rs.startW - newW;
            }
            // 南（下边）方向：高增大，y 不变
            if (dir.includes('s')) newH = Math.max(MIN_H, rs.startH + dyS);
            // 北（上边）方向：高增大，y 减小
            if (dir.includes('n')) {
                newH = Math.max(MIN_H, rs.startH - dyS);
                newY = rs.startY + rs.startH - newH;
            }

            nd.x = newX;
            nd.y = newY;
            nd.w = newW;
            nd.el.style.left    = newX + 'px';
            nd.el.style.top     = newY + 'px';
            nd.el.style.width   = newW + 'px';
            // 高度固定时（非自适应）才写 height；这里直接设置，覆盖自适应
            nd.el.style.height  = newH + 'px';

            this._redrawConnections(rs.id);
        }
    }

    _onMouseUp(e) {
        this.isPanning = false;
        this.container.classList.remove('panning');

        // ── 框选结束 ──
        if (this.isSelecting) {
            this.isSelecting = false;
            if (this.selectRect) {
                this.selectRect.remove();
                this.selectRect = null;
            }
            // 清除节点高亮
            Object.values(this.nodes).forEach(nd => nd.el.classList.remove('box-selected'));

            // 有选中节点才显示分组气泡
            if (this.selectedNodes.size > 0) {
                this._showGroupPopup(e.clientX, e.clientY, new Set(this.selectedNodes));
            }
            this.selectedNodes.clear();
            return;
        }

        // ── 分组拖拽结束 ──
        if (this.draggingGroup) {
            this.draggingGroup = null;
            return;
        }

        if (this.dragging) {
            const rs = this.dragging;
            const nd = this.nodes[rs.id];
            // 只在实际移动了才记录历史
            if (nd && (rs.startNodeX !== nd.x || rs.startNodeY !== nd.y)) {
                this._pushUndo({ type:'move_node', id:rs.id, ox:rs.startNodeX, oy:rs.startNodeY });
            }
            this.dragging = null;
        }

        if (this.resizing) {
            const rs = this.resizing;
            const nd = this.nodes[rs.id];
            if (nd) {
                nd.h = nd.el.offsetHeight;
                // 只在实际变化了才记录历史
                if (rs.startX !== nd.x || rs.startY !== nd.y || rs.startW !== nd.w || rs.startH !== nd.h) {
                    this._pushUndo({
                        type: 'resize_node',
                        id:   rs.id,
                        ox: rs.startX, oy: rs.startY,
                        ow: rs.startW, oh: rs.startH,
                    });
                }
            }
            this.resizing = null;
            document.body.style.cursor = '';
        }

        if (this.isConnecting) {
            // 优先使用磁吸目标，否则回退到鼠标正下方的 pin
            let targetId = this.connSnapTarget || null;
            if (!targetId) {
                const el  = document.elementFromPoint(e.clientX, e.clientY);
                const pin = el && el.closest('.input-pin');
                if (pin && pin.dataset.nodeId && pin.dataset.nodeId !== this.connFrom) {
                    targetId = pin.dataset.nodeId;
                }
            }
            if (targetId) {
                this._createConnection(this.connFrom, targetId);
            }
            this.connSnapTarget = null;
            this._cancelConnect();
        }

        document.querySelectorAll('.input-pin').forEach(p => p.classList.remove('connectable', 'snap-target'));
    }

    _onWheel(e) {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        const newZoom = Math.min(4, Math.max(0.2, this.zoom * factor));

        // 以鼠标为中心缩放
        const r = this.container.getBoundingClientRect();
        const mx = e.clientX - r.left;
        const my = e.clientY - r.top;
        this.panX = mx - (mx - this.panX) * (newZoom / this.zoom);
        this.panY = my - (my - this.panY) * (newZoom / this.zoom);
        this.zoom = newZoom;

        this._applyTransform();
        this._redrawAllConnections();
    }

    /* ════════════════════════════════════════════════════
       UNDO 系统
    ════════════════════════════════════════════════════ */
    _pushUndo(record) {
        this.undoStack.push(record);
        if (this.undoStack.length > this.MAX_UNDO) this.undoStack.shift();
    }

    _undo() {
        const rec = this.undoStack.pop();
        if (!rec) return;
        switch (rec.type) {
            case 'create_node':
                this._deleteNodeSilent(rec.id);
                break;
            case 'delete_node':
                this._restoreNode(rec.snap);
                rec.conns.forEach(c => this._createConnectionSilent(c.fromId, c.toId, c.id));
                break;
            case 'move_node': {
                const nd = this.nodes[rec.id];
                if (!nd) break;
                nd.x = rec.ox; nd.y = rec.oy;
                nd.el.style.left = rec.ox + 'px';
                nd.el.style.top  = rec.oy + 'px';
                this._redrawConnections(rec.id);
                break;
            }
            case 'resize_node': {
                const nd = this.nodes[rec.id];
                if (!nd) break;
                nd.x = rec.ox; nd.y = rec.oy; nd.w = rec.ow;
                nd.el.style.left   = rec.ox + 'px';
                nd.el.style.top    = rec.oy + 'px';
                nd.el.style.width  = rec.ow + 'px';
                nd.el.style.height = rec.oh + 'px';
                this._redrawConnections(rec.id);
                break;
            }
            case 'edit_node': {
                const nd = this.nodes[rec.id];
                if (!nd) break;
                nd[rec.field] = rec.oldVal;
                this._updateNodeEl(rec.id);
                break;
            }
            case 'create_conn':
                this._deleteConnectionSilent(rec.id);
                break;
            case 'delete_conn':
                this._createConnectionSilent(rec.fromId, rec.toId, rec.id, rec.label || '', rec.style || 'solid');
                break;
            case 'conn_label': {
                const cn = this.connections[rec.id];
                if (cn) {
                    cn.label = rec.oldLabel;
                    this._updateConnLabel(rec.id);
                    this._save();
                }
                break;
            }
            case 'conn_style': {
                const cn = this.connections[rec.id];
                if (cn) {
                    cn.style = rec.oldStyle;
                    this._drawConnection(rec.id);
                    this._save();
                }
                break;
            }
            // ── note 节点相关 ──
            case 'add_note':
                this._removeNote(rec.id);
                break;
            case 'del_note':
                if (rec.snap) this._buildNoteEl({ ...rec.snap });
                break;
            case 'edit_note': {
                // 对于 note 编辑，目前仅弹出提示（完整文本历史需要额外存储旧值）
                // 此处保留 hook 供后续扩展
                break;
            }
        }
    }

    _bindUndoKey() {
        document.addEventListener('keydown', e => {
            const tag = document.activeElement?.tagName;
            const inInput = tag === 'INPUT' || tag === 'TEXTAREA' ||
                            document.activeElement?.isContentEditable;
            if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
                if (inInput) return;
                e.preventDefault();
                this._undo();
            }
            // Delete/Backspace 删除已选连线
            if ((e.key === 'Delete' || e.key === 'Backspace') && !inInput) {
                if (this.selectedConnId) {
                    e.preventDefault();
                    this._deleteConnection(this.selectedConnId);
                }
            }
        });
    }

    /* ════════════════════════════════════════════════════
       NODE - 内部静默方法（不记历史）
    ════════════════════════════════════════════════════ */
    _deleteNodeSilent(id) {
        const nd = this.nodes[id];
        if (!nd) return;
        nd.el.remove();
        delete this.nodes[id];
        Object.keys(this.connections).forEach(cid => {
            const cn = this.connections[cid];
            if (cn.fromId === id || cn.toId === id) {
                cn.path.remove();
                delete this.connections[cid];
            }
        });
    }

    _restoreNode(snap) {
        // snap: { id, x, y, w, h, title, content, completed, type, src }
        if (snap.type === 'image') {
            const nd = this._buildImageEl(snap.id, snap.src, snap.x, snap.y);
            if (snap.w) nd.el.style.width  = snap.w + 'px';
            if (snap.h) nd.el.style.height = snap.h + 'px';
        } else if (snap.type === 'note') {
            this._buildNoteEl({ ...snap });
        } else {
            this._buildNodeEl({ ...snap });
        }
    }

    /* ════════════════════════════════════════════════════
       NODE - 公共方法（记录历史）
    ════════════════════════════════════════════════════ */
    _createNode(opts = {}) {
        opts.id = opts.id || uid();
        if (opts.x === undefined) opts.x = 80 + Math.random() * 300;
        if (opts.y === undefined) opts.y = 80 + Math.random() * 200;
        const nd = this._buildNodeEl(opts);
        this._pushUndo({ type: 'create_node', id: nd.id });
        return nd;
    }

    /* ════════════════════════════════════════════════════
       NODE - 核心构建方法（被公共/撤销共用）
    ════════════════════════════════════════════════════ */
    _buildNodeEl({ id, x, y, w=200, title='新节点', content='', completed=false, type='normal', bgColor=null } = {}) {
        const el = document.createElement('div');
        el.className = 'node' + (type === 'ai' ? ' ai-node' : '') + (completed ? ' completed' : '');
        el.dataset.nodeId = id;
        el.style.cssText  = `left:${x}px; top:${y}px; width:${w}px;`;
        // 只在有自定义颜色时才覆盖 CSS 变量（保持默认白色节点）
        if (bgColor) {
            el.style.background = bgColor;
        }
        const headerBg = bgColor ? this._calcHeaderBg(bgColor) : '';

        el.innerHTML = `
            <div class="node-header"${headerBg ? ` style="background:${headerBg}"` : ''}>
                <div class="node-title" contenteditable="true" spellcheck="false" data-field="title">${this._sanitizeHtml(title)}</div>
                <button class="node-del-btn" title="删除节点" data-node-id="${id}">✕</button>
            </div>
            <div class="node-body">
                <div class="node-text" contenteditable="true" spellcheck="false" data-field="content">${this._sanitizeHtml(content)}</div>
                <label class="node-check">
                    <input type="checkbox" ${completed ? 'checked' : ''}> 已完成
                </label>
            </div>
            <div class="pin input-pin"  data-node-id="${id}"></div>
            <div class="pin output-pin" data-node-id="${id}"></div>
            <div class="resize-handle n"  data-node-id="${id}" data-dir="n"></div>
            <div class="resize-handle s"  data-node-id="${id}" data-dir="s"></div>
            <div class="resize-handle e"  data-node-id="${id}" data-dir="e"></div>
            <div class="resize-handle w"  data-node-id="${id}" data-dir="w"></div>
            <div class="resize-handle ne" data-node-id="${id}" data-dir="ne"></div>
            <div class="resize-handle nw" data-node-id="${id}" data-dir="nw"></div>
            <div class="resize-handle se" data-node-id="${id}" data-dir="se"></div>
            <div class="resize-handle sw" data-node-id="${id}" data-dir="sw"></div>
        `;

        // ── 右上角删除按钮 ──
        el.querySelector('.node-del-btn').addEventListener('click', ev => {
            ev.stopPropagation();
            this._deleteNode(id);
        });

        // ── 标题内联编辑（contenteditable 始终可编辑） ──
        const titleDiv = el.querySelector('.node-title');
        let titleSnapshot = null; // 记录 focus 时的 innerHTML 快照
        titleDiv.addEventListener('focus', ev => {
            ev.stopPropagation();
            const nd = this.nodes[id];
            titleSnapshot = titleDiv.innerHTML;
        });
        titleDiv.addEventListener('blur', ev => {
            const nd = this.nodes[id];
            const newHtml = titleDiv.innerHTML.trim();
            const fallback = titleSnapshot || '';
            if (!titleDiv.textContent.trim()) {
                // 还原为快照（不能清空标题）
                titleDiv.innerHTML = fallback;
                titleSnapshot = null;
                // blur 时隐藏工具栏（若焦点没移到工具栏内）
                setTimeout(() => {
                    if (this._richToolbar && !this._richToolbar.contains(document.activeElement)) {
                        this._richToolbar.style.display = 'none';
                    }
                }, 80);
                return;
            }
            if (newHtml !== titleSnapshot) {
                this._pushUndo({ type: 'edit_node', id, field: 'title', oldVal: titleSnapshot, newVal: newHtml });
                nd.title = newHtml;
            }
            titleSnapshot = null;
            // blur 时隐藏工具栏（若焦点没移到工具栏内）
            setTimeout(() => {
                if (this._richToolbar && !this._richToolbar.contains(document.activeElement)) {
                    this._richToolbar.style.display = 'none';
                }
            }, 80);
        });
        titleDiv.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); titleDiv.blur(); }
            if (e.key === 'Escape') { titleDiv.innerHTML = titleSnapshot || titleDiv.innerHTML; titleDiv.blur(); }
            e.stopPropagation();
        });
        titleDiv.addEventListener('mousedown', e => e.stopPropagation());
        titleDiv.addEventListener('click', e => e.stopPropagation());

        // ── 内容内联编辑（contenteditable 始终可编辑） ──
        const textDiv = el.querySelector('.node-text');
        let contentSnapshot = null;
        textDiv.addEventListener('focus', ev => {
            ev.stopPropagation();
            contentSnapshot = textDiv.innerHTML;
        });
        textDiv.addEventListener('blur', ev => {
            const nd = this.nodes[id];
            const newHtml = textDiv.innerHTML;
            if (newHtml !== contentSnapshot) {
                this._pushUndo({ type: 'edit_node', id, field: 'content', oldVal: contentSnapshot, newVal: newHtml });
                nd.content = newHtml;
                this._redrawConnections(id);
            }
            contentSnapshot = null;
            // blur 时隐藏工具栏（若焦点没移到工具栏内）
            setTimeout(() => {
                if (this._richToolbar && !this._richToolbar.contains(document.activeElement)) {
                    this._richToolbar.style.display = 'none';
                }
            }, 80);
        });
        textDiv.addEventListener('keydown', e => {
            if (e.key === 'Escape') { textDiv.innerHTML = contentSnapshot || textDiv.innerHTML; textDiv.blur(); }
            e.stopPropagation();
        });
        textDiv.addEventListener('mousedown', e => e.stopPropagation());
        textDiv.addEventListener('click', e => e.stopPropagation());

        // 双击打开完整编辑 Modal（仍保留，在 pin/handle/标题/内容 之外触发）
        el.addEventListener('dblclick', ev => {
            if (ev.target.closest('.pin') || ev.target.closest('.resize-handle')
                || ev.target.closest('.node-title') || ev.target.closest('.node-text')
                || ev.target.closest('.node-del-btn')) return;
            this._openEditModal(id);
        });

        // 复选框
        el.querySelector('.node-check input').addEventListener('change', ev => {
            const nd = this.nodes[id];
            nd.completed = ev.target.checked;
            el.classList.toggle('completed', nd.completed);
            ev.stopPropagation();
        });

        // Output Pin：开始连线
        el.querySelector('.output-pin').addEventListener('mousedown', ev => {
            if (ev.button !== 0) return;
            ev.stopPropagation();
            ev.preventDefault();
            this._startConnect(id);
        });

        // Input Pin：阻止冒泡（让 mouseup 处理）
        el.querySelector('.input-pin').addEventListener('mousedown', ev => {
            ev.stopPropagation();
        });

        // Resize Handles：8 方向
        el.querySelectorAll('.resize-handle').forEach(handle => {
            handle.addEventListener('mousedown', ev => {
                if (ev.button !== 0) return;
                ev.stopPropagation();
                ev.preventDefault();
                const nd = this.nodes[id];
                this.resizing = {
                    id,
                    dir:         handle.dataset.dir,
                    startMouseX: ev.clientX,
                    startMouseY: ev.clientY,
                    startX:      nd.x,
                    startY:      nd.y,
                    startW:      nd.el.offsetWidth,
                    startH:      nd.el.offsetHeight,
                };
            });
        });

        this.nodeLayer.appendChild(el);

        const nd = { id, x, y, w, title, content, completed, type, bgColor: bgColor || null, el };
        this.nodes[id] = nd;

        /* ── 拖拽区域：Header + Body（排除所有可交互子元素）── */
        const startDragIfAllowed = (ev) => {
            if (ev.button !== 0) return;
            // 不允许拖拽的目标：pin / resize handle / 删除按钮 / 编辑中的标题 / 内容区 / 复选框
            if (ev.target.closest('.pin'))          return;
            if (ev.target.closest('.resize-handle')) return;
            if (ev.target.closest('.node-del-btn')) return;
        if (ev.target.closest('.node-title')) return;
        if (ev.target.closest('.node-text'))   return;
            if (ev.target.closest('.node-check'))   return;
            this.dragging = {
                id,
                startMouseX: ev.clientX,
                startMouseY: ev.clientY,
                startNodeX:  this.nodes[id].x,
                startNodeY:  this.nodes[id].y,
            };
        };
        el.querySelector('.node-header').addEventListener('mousedown', startDragIfAllowed);
        el.querySelector('.node-body').addEventListener('mousedown',   startDragIfAllowed);

        return nd;
    }

    _esc(s) {
        return String(s)
            .replace(/&/g,'&amp;')
            .replace(/</g,'&lt;')
            .replace(/>/g,'&gt;')
            .replace(/"/g,'&quot;');
    }

    /**
     * 将原始字符串转义为安全的 HTML（纯文本输入），
     * 同时允许已经是富文本 innerHTML 的内容（含 <b>/<i>/<u>/<s>/<span> 等）直接通过。
     * 判断依据：如果字符串含有被允许的富文本标签，视为 HTML；否则做文本转义。
     */
    _sanitizeHtml(s) {
        if (!s) return '';
        // 若包含富文本标签（b/i/u/s/span/br/div），直接返回（已是 HTML）
        if (/<(b|i|u|s|span|br|div|strong|em)[^>]*>/i.test(s)) return s;
        // 否则按纯文本转义
        return String(s)
            .replace(/&/g,'&amp;')
            .replace(/</g,'&lt;')
            .replace(/>/g,'&gt;')
            .replace(/"/g,'&quot;');
    }

    _updateNodeEl(id) {
        const nd = this.nodes[id];
        if (!nd) return;
        // 用 innerHTML 还原富文本内容（跳过正在聚焦的元素以免打断编辑）
        const titleEl = nd.el.querySelector('.node-title');
        if (document.activeElement !== titleEl) titleEl.innerHTML = this._sanitizeHtml(nd.title);
        const textEl = nd.el.querySelector('.node-text');
        if (document.activeElement !== textEl) textEl.innerHTML = this._sanitizeHtml(nd.content);
        nd.el.querySelector('.node-check input').checked = nd.completed;
        nd.el.style.width = nd.w + 'px';
        nd.el.classList.toggle('completed', nd.completed);
        // 应用颜色（有自定义色才覆盖，否则回退 CSS 变量白色）
        const headerEl = nd.el.querySelector('.node-header');
        if (nd.bgColor) {
            nd.el.style.background = nd.bgColor;
            if (headerEl) headerEl.style.background = this._calcHeaderBg(nd.bgColor);
            this._applyNodeTextColor(nd, nd.bgColor);
        } else {
            nd.el.style.background = '';
            if (headerEl) {
                headerEl.style.background = '';
                headerEl.style.color = '';
            }
            nd.el.querySelectorAll('.node-title, .node-text').forEach(el => el.style.color = '');
        }
        this._redrawConnections(id);
    }

    _deleteNode(id) {
        const nd = this.nodes[id];
        if (!nd) return;

        // ① 收集与此节点相关的所有连线快照（在删除前）
        const relatedConns = Object.values(this.connections)
            .filter(cn => cn.fromId === id || cn.toId === id)
            .map(cn => ({ id: cn.id, fromId: cn.fromId, toId: cn.toId }));

        // ② 节点快照
        const snap = {
            id,
            x:         nd.x,
            y:         nd.y,
            w:         nd.w || nd.el.offsetWidth,
            h:         nd.h || nd.el.offsetHeight,
            title:     nd.title     || '',
            content:   nd.content   || '',
            completed: nd.completed || false,
            type:      nd.type      || 'normal',
            src:       nd.src       || null,
        };

        // ③ 推入撤销历史（包含连线信息）
        this._pushUndo({ type: 'delete_node', snap, conns: relatedConns });

        // ④ 执行真正的静默删除
        this._deleteNodeSilent(id);
    }

    /* ════════════════════════════════════════════════════
       CONNECTION
    ════════════════════════════════════════════════════ */
    _startConnect(fromId) {
        this.isConnecting = true;
        this.connFrom     = fromId;

        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.classList.add('conn-path', 'temp');
        this.svgGroup.appendChild(p);
        this.connTempPath = p;
    }

    _cancelConnect() {
        this.isConnecting = false;
        if (this.connTempPath) { this.connTempPath.remove(); this.connTempPath = null; }
        this.connFrom = null;
    }

    /* ── 创建 SVG label 组（<rect> + <text>），附加到 svgGroup ── */
    _createConnLabelEl(cid) {
        const NS = 'http://www.w3.org/2000/svg';
        const g  = document.createElementNS(NS, 'g');
        g.classList.add('conn-label-g');
        g.dataset.connId = cid;

        const rect = document.createElementNS(NS, 'rect');
        rect.classList.add('conn-label-rect');

        const text = document.createElementNS(NS, 'text');
        text.classList.add('conn-label-text');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('dominant-baseline', 'middle');

        g.appendChild(rect);
        g.appendChild(text);
        this.svgGroup.appendChild(g);

        // 双击 label 区域 → 开始编辑
        g.addEventListener('dblclick', ev => {
            ev.stopPropagation();
            this._editConnLabel(cid);
        });

        return g;
    }

    /* ── 更新 label 元素的内容与位置 ── */
    _updateConnLabel(cid) {
        const cn = this.connections[cid];
        if (!cn || !cn.labelEl) return;
        const label = cn.label || '';
        const g     = cn.labelEl;
        const text  = g.querySelector('text');
        const rect  = g.querySelector('rect');

        if (!label) {
            g.style.display = 'none';
            return;
        }
        g.style.display = '';

        // 贝塞尔曲线 t=0.5 中点（三次贝塞尔）
        const a  = this._getPinPos(cn.fromId, 'output');
        const b  = this._getPinPos(cn.toId,   'input');
        const cc = Math.min(Math.abs(b.x - a.x) * 0.6 + 40, 300);
        const p1x = a.x + cc, p1y = a.y;
        const p2x = b.x - cc, p2y = b.y;
        // t=0.5 cubic bezier
        const mx = 0.125*a.x + 0.375*p1x + 0.375*p2x + 0.125*b.x;
        const my = 0.125*a.y + 0.375*p1y + 0.375*p2y + 0.125*b.y;

        text.textContent = label;
        // 测量文字宽度：优先用 SVG API，回退用字符数估算
        const pad = 8;
        let tw = label.length * 7; // 字符数估算（约 7px/char for 11px font）
        try {
            const measured = text.getComputedTextLength();
            if (measured > 0) tw = measured;
        } catch(e) {}
        const rw = Math.max(tw + pad * 2, 36); // 最小宽度 36px
        const rh = 22;
        rect.setAttribute('x',      mx - rw / 2);
        rect.setAttribute('y',      my - rh / 2);
        rect.setAttribute('width',  rw);
        rect.setAttribute('height', rh);
        rect.setAttribute('rx',     11);
        text.setAttribute('x', mx);
        text.setAttribute('y', my);
    }

    /* ── 双击连线：弹出浮动 input 编辑标签 ── */
    _editConnLabel(cid) {
        const cn = this.connections[cid];
        if (!cn) return;

        // 计算屏幕坐标（贝塞尔中点 → 容器坐标）
        const a  = this._getPinPos(cn.fromId, 'output');
        const b  = this._getPinPos(cn.toId,   'input');
        const cc = Math.min(Math.abs(b.x - a.x) * 0.6 + 40, 300);
        const p1x = a.x + cc, p1y = a.y;
        const p2x = b.x - cc, p2y = b.y;
        const mx = 0.125*a.x + 0.375*p1x + 0.375*p2x + 0.125*b.x;
        const my = 0.125*a.y + 0.375*p1y + 0.375*p2y + 0.125*b.y;
        // canvas → screen
        const sx = mx * this.zoom + this.panX + this.container.getBoundingClientRect().left;
        const sy = my * this.zoom + this.panY + this.container.getBoundingClientRect().top;

        // 移除旧浮动 input（如有）
        document.querySelectorAll('.conn-label-input').forEach(el => el.remove());

        const inp = document.createElement('input');
        inp.type  = 'text';
        inp.value = cn.label || '';
        inp.className = 'conn-label-input';
        inp.style.cssText = `
            position:fixed;
            left:${sx}px; top:${sy}px;
            transform:translate(-50%,-50%);
            z-index:9999;
        `;
        document.body.appendChild(inp);
        inp.focus();
        inp.select();

        const commit = () => {
            const oldLabel = cn.label || '';
            const newLabel = inp.value.trim();
            inp.remove();
            if (newLabel === oldLabel) return;
            this._pushUndo({ type: 'conn_label', id: cid, oldLabel, newLabel });
            cn.label = newLabel;
            this._updateConnLabel(cid);
            this._save();
        };
        inp.addEventListener('keydown', ev => {
            if (ev.key === 'Enter')  { ev.preventDefault(); commit(); }
            if (ev.key === 'Escape') { inp.remove(); }
        });
        inp.addEventListener('blur', commit);
    }

    /* ── 连线选中/取消选中 ── */
    _selectConn(cid) {
        if (this.selectedConnId === cid) return;
        this._deselectConn();
        this.selectedConnId = cid;
        const cn = this.connections[cid];
        if (!cn) return;
        cn.path.classList.add('selected');
        if (cn.labelEl) cn.labelEl.classList.add('selected');
    }

    _deselectConn() {
        if (!this.selectedConnId) return;
        const cn = this.connections[this.selectedConnId];
        if (cn) {
            cn.path.classList.remove('selected');
            if (cn.labelEl) cn.labelEl.classList.remove('selected');
        }
        this.selectedConnId = null;
    }

    /* ── 连线右键菜单 ── */
    _showConnContextMenu(cid, ev) {
        // 移除已有菜单
        document.querySelectorAll('.conn-ctx-menu').forEach(el => el.remove());

        const cn  = this.connections[cid];
        if (!cn) return;
        const isDashed = cn.style === 'dashed';

        const menu = document.createElement('div');
        menu.className = 'conn-ctx-menu';
        menu.innerHTML = `
            <div class="ccm-item ccm-toggle-dash" data-cid="${cid}">
                <i class="fas ${isDashed ? 'fa-minus' : 'fa-ellipsis-h'}"></i>
                ${isDashed ? '切换为实线' : '切换为虚线'}
            </div>
            <div class="ccm-divider"></div>
            <div class="ccm-item ccm-edit-label" data-cid="${cid}">
                <i class="fas fa-tag"></i> 编辑标签
            </div>
            <div class="ccm-divider"></div>
            <div class="ccm-item ccm-delete" data-cid="${cid}">
                <i class="fas fa-trash"></i> 删除连线
            </div>
        `;

        // 定位
        menu.style.cssText = `position:fixed;left:${ev.clientX}px;top:${ev.clientY}px;z-index:100010;`;
        document.body.appendChild(menu);

        // 防止溢出屏幕
        requestAnimationFrame(() => {
            const r = menu.getBoundingClientRect();
            if (r.right  > window.innerWidth)  menu.style.left = (ev.clientX - r.width)  + 'px';
            if (r.bottom > window.innerHeight)  menu.style.top  = (ev.clientY - r.height) + 'px';
        });

        // 点击事件
        menu.querySelector('.ccm-toggle-dash').addEventListener('click', () => {
            menu.remove();
            this._toggleConnStyle(cid);
        });
        menu.querySelector('.ccm-edit-label').addEventListener('click', () => {
            menu.remove();
            this._editConnLabel(cid);
        });
        menu.querySelector('.ccm-delete').addEventListener('click', () => {
            menu.remove();
            this._deleteConnection(cid);
        });

        // 点击其他区域关闭
        const close = (e) => {
            if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', close); }
        };
        setTimeout(() => document.addEventListener('mousedown', close), 0);
    }

    /* ── 切换连线虚实 ── */
    _toggleConnStyle(cid) {
        const cn = this.connections[cid];
        if (!cn) return;
        const oldStyle = cn.style || 'solid';
        const newStyle = oldStyle === 'dashed' ? 'solid' : 'dashed';
        this._pushUndo({ type: 'conn_style', id: cid, oldStyle, newStyle });
        cn.style = newStyle;
        this._drawConnection(cid);
        this._save();
    }

    /* ── 绑定单个 path 的交互事件 ── */
    _bindConnPathEvents(p, cid) {
        // 单击选中
        p.addEventListener('click', ev => {
            ev.stopPropagation();
            this._selectConn(cid);
        });
        // 右键显示菜单
        p.addEventListener('contextmenu', ev => {
            ev.preventDefault();
            ev.stopPropagation();
            this._selectConn(cid);
            this._showConnContextMenu(cid, ev);
        });
        // 双击编辑标签
        p.addEventListener('dblclick', ev => {
            ev.stopPropagation();
            this._editConnLabel(cid);
        });
    }

    _createConnection(fromId, toId) {
        // 避免重复连接
        const exists = Object.values(this.connections).some(
            c => c.fromId === fromId && c.toId === toId
        );
        if (exists) return;

        const cid = 'c' + uid();
        const p   = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.classList.add('conn-path');
        p.dataset.connId = cid;
        this._bindConnPathEvents(p, cid);

        this.svgGroup.appendChild(p);
        const labelEl = this._createConnLabelEl(cid);
        this.connections[cid] = { id:cid, fromId, toId, path:p, label:'', style:'solid', labelEl };
        this._drawConnection(cid);
        // 记录撤销历史
        this._pushUndo({ type: 'create_conn', id: cid });
    }

    _drawConnection(cid) {
        const cn = this.connections[cid];
        if (!cn) return;
        const a  = this._getPinPos(cn.fromId, 'output');
        const b  = this._getPinPos(cn.toId,   'input');
        cn.path.setAttribute('d', this._bezierPath(a.x, a.y, b.x, b.y));
        // 虚线切换
        if (cn.style === 'dashed') {
            cn.path.setAttribute('stroke-dasharray', '8 5');
        } else {
            cn.path.removeAttribute('stroke-dasharray');
        }
        this._updateConnLabel(cid);
    }

    _redrawConnections(nodeId) {
        Object.values(this.connections).forEach(cn => {
            if (cn.fromId === nodeId || cn.toId === nodeId) {
                this._drawConnection(cn.id);
            }
        });
    }

    _redrawAllConnections() {
        Object.keys(this.connections).forEach(cid => this._drawConnection(cid));
    }

    _deleteConnection(cid) {
        const cn = this.connections[cid];
        if (!cn) return;
        // 记录撤销历史
        this._pushUndo({ type: 'delete_conn', id: cid, fromId: cn.fromId, toId: cn.toId, label: cn.label || '', style: cn.style || 'solid' });
        if (this.selectedConnId === cid) this.selectedConnId = null;
        cn.path.remove();
        if (cn.labelEl) cn.labelEl.remove();
        delete this.connections[cid];
    }

    /* 静默版本：撤销内部调用，不记录历史 */
    _createConnectionSilent(fromId, toId, cid, label = '', style = 'solid') {
        const exists = Object.values(this.connections).some(c => c.id === cid);
        if (exists) return;
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.classList.add('conn-path');
        p.dataset.connId = cid;
        this._bindConnPathEvents(p, cid);
        this.svgGroup.appendChild(p);
        const labelEl = this._createConnLabelEl(cid);
        this.connections[cid] = { id: cid, fromId, toId, path: p, label, style, labelEl };
        this._drawConnection(cid);
    }

    _deleteConnectionSilent(cid) {
        const cn = this.connections[cid];
        if (!cn) return;
        cn.path.remove();
        if (cn.labelEl) cn.labelEl.remove();
        delete this.connections[cid];
    }

    /* ════════════════════════════════════════════════════
       TOOLBAR
    ════════════════════════════════════════════════════ */
    _bindToolbar() {
        document.getElementById('addNodeBtn').addEventListener('click', () => {
            const c = this._toCanvas(
                this.container.clientWidth  / 2,
                this.container.clientHeight / 2
            );
            this._createNode({ x: c.x - 100, y: c.y - 60 });
        });

        document.getElementById('addAiNodeBtn').addEventListener('click', () => {
            const c = this._toCanvas(
                this.container.clientWidth  / 2,
                this.container.clientHeight / 2
            );
            this._createNode({ x: c.x - 100, y: c.y - 60, type:'ai', title:'AI处理节点' });
        });

        document.getElementById('addNoteBtn').addEventListener('click', () => {
            const c = this._toCanvas(
                this.container.clientWidth  / 2,
                this.container.clientHeight / 2
            );
            this._createNote({ x: c.x - 120, y: c.y - 80 });
        });

        document.getElementById('autoGenerateBtn').addEventListener('click', () => {
            this._autoGenerate();
        });

        document.getElementById('saveBtn').addEventListener('click', () => {
            this._save();
        });

        document.getElementById('openBtn').addEventListener('click', () => {
            this._open();
        });

        // 文件选择器：选中文件后读取并加载
        document.getElementById('openFileInput').addEventListener('change', e => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = ev => {
                try {
                    const data = JSON.parse(ev.target.result);
                    this._loadFromData(data);
                } catch (err) {
                    alert('文件解析失败，请确保选择的是有效的蓝图 JSON 文件。\n' + err.message);
                }
            };
            reader.readAsText(file);
            // 重置 input，允许重复打开同一文件
            e.target.value = '';
        });

        document.getElementById('clearBtn').addEventListener('click', () => {
            if (confirm('确认清空所有节点和连线？')) this._clearAll();
        });

        // 缩放
        document.getElementById('zoomInBtn').addEventListener('click', () => {
            this._zoomAt(1.2);
        });
        document.getElementById('zoomOutBtn').addEventListener('click', () => {
            this._zoomAt(1/1.2);
        });
        document.getElementById('zoomSlider').addEventListener('input', e => {
            const newZ = parseInt(e.target.value) / 100;
            this.panX = this.container.clientWidth  / 2 - (this.container.clientWidth  / 2 - this.panX) * (newZ / this.zoom);
            this.panY = this.container.clientHeight / 2 - (this.container.clientHeight / 2 - this.panY) * (newZ / this.zoom);
            this.zoom = newZ;
            this._applyTransform();
            this._redrawAllConnections();
        });
    }

    _zoomAt(factor) {
        const newZ = Math.min(4, Math.max(0.2, this.zoom * factor));
        const cx   = this.container.clientWidth  / 2;
        const cy   = this.container.clientHeight / 2;
        this.panX  = cx - (cx - this.panX) * (newZ / this.zoom);
        this.panY  = cy - (cy - this.panY) * (newZ / this.zoom);
        this.zoom  = newZ;
        this._applyTransform();
        this._redrawAllConnections();
    }

    /* ════════════════════════════════════════════════════
       MODALS
    ════════════════════════════════════════════════════ */
    _bindModals() {
        // 普通节点弹窗
        const modal  = document.getElementById('nodeEditModal');
        const slider = document.getElementById('nodeWidthSlider');
        const widVal = document.getElementById('widthValue');

        slider.addEventListener('input', () => { widVal.textContent = slider.value + 'px'; });

        document.getElementById('closeModalBtn').addEventListener('click', () => {
            modal.classList.remove('show');
        });
        document.getElementById('saveNodeBtn').addEventListener('click', () => {
            if (!this.editingNodeId) return;
            const nd = this.nodes[this.editingNodeId];
            if (!nd) return;
            nd.title     = document.getElementById('nodeTitleInput').value;
            nd.content   = document.getElementById('nodeContentInput').value;
            nd.w         = parseInt(document.getElementById('nodeWidthSlider').value);
            nd.completed = document.getElementById('nodeCompletedCheckbox').checked;
            this._updateNodeEl(this.editingNodeId);
            modal.classList.remove('show');
        });
        document.getElementById('deleteNodeBtn').addEventListener('click', () => {
            if (!this.editingNodeId) return;
            this._deleteNode(this.editingNodeId);
            modal.classList.remove('show');
        });
        modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('show'); });

        // AI 节点弹窗
        const aiModal = document.getElementById('aiNodeEditModal');
        document.getElementById('closeAiModalBtn').addEventListener('click', () => {
            aiModal.classList.remove('show');
        });
        document.getElementById('saveAiNodeBtn').addEventListener('click', () => {
            if (!this.editingNodeId) return;
            const nd = this.nodes[this.editingNodeId];
            if (!nd) return;
            nd.title   = document.getElementById('aiNodeTitleInput').value;
            nd.content = document.getElementById('aiInputData').value;
            this._updateNodeEl(this.editingNodeId);
            aiModal.classList.remove('show');
        });
        document.getElementById('deleteAiNodeBtn').addEventListener('click', () => {
            if (!this.editingNodeId) return;
            this._deleteNode(this.editingNodeId);
            aiModal.classList.remove('show');
        });
        document.getElementById('processAiBtn').addEventListener('click', () => {
            this._processAiNode();
        });
        aiModal.addEventListener('click', e => { if (e.target === aiModal) aiModal.classList.remove('show'); });
    }

    _openEditModal(id) {
        const nd = this.nodes[id];
        if (!nd) return;
        this.editingNodeId = id;

        if (nd.type === 'ai') {
            document.getElementById('aiNodeTitleInput').value = nd.title;
            document.getElementById('aiInputData').value      = nd.content;
            document.getElementById('aiResult').textContent   = '（点击"执行处理"后显示结果）';
            document.getElementById('aiNodeEditModal').classList.add('show');
        } else {
            document.getElementById('nodeTitleInput').value       = nd.title;
            document.getElementById('nodeContentInput').value     = nd.content;
            document.getElementById('nodeWidthSlider').value      = nd.w;
            document.getElementById('widthValue').textContent     = nd.w + 'px';
            document.getElementById('nodeCompletedCheckbox').checked = nd.completed;
            document.getElementById('nodeEditModal').classList.add('show');
        }
    }

    /* ════════════════════════════════════════════════════
       AI 处理
    ════════════════════════════════════════════════════ */
    async _processAiNode() {
        const apiKey  = document.getElementById('aiApiKey').value.trim();
        const apiUrl  = (document.getElementById('aiApiEndpoint').value.trim()
                        || 'https://api.openai.com/v1/chat/completions');
        const prompt  = document.getElementById('aiPromptInput').value.trim();
        const input   = document.getElementById('aiInputData').value.trim();
        const resultEl = document.getElementById('aiResult');

        if (!input) { resultEl.textContent = '请先填写输入数据。'; return; }
        if (!apiKey) { resultEl.textContent = '请填写 API 密钥。'; return; }

        resultEl.textContent = '处理中...';
        document.getElementById('loadingIndicator').classList.add('show');

        try {
            const resp = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: [
                        { role: 'system', content: prompt || '你是一个逻辑分析助手。' },
                        { role: 'user',   content: input },
                    ],
                }),
            });
            const data = await resp.json();
            if (data.error) throw new Error(data.error.message);
            resultEl.textContent = data.choices?.[0]?.message?.content ?? '无结果';
        } catch (err) {
            resultEl.textContent = '错误：' + err.message;
        } finally {
            document.getElementById('loadingIndicator').classList.remove('show');
        }
    }

    /* ════════════════════════════════════════════════════
       MODEL CONFIG（模型配置表）
    ════════════════════════════════════════════════════ */
    _getModelConfig(modelKey) {
        const configs = {
            // OpenAI
            openai_gpt4o: {
                provider: 'openai',
                model:    'gpt-4o',
                url:      'https://api.openai.com/v1/chat/completions',
                keyHint:  'sk-...',
            },
            openai_gpt4o_mini: {
                provider: 'openai',
                model:    'gpt-4o-mini',
                url:      'https://api.openai.com/v1/chat/completions',
                keyHint:  'sk-...',
            },
            // 通义千问（兼容 OpenAI 接口）
            qwen_plus: {
                provider: 'qwen',
                model:    'qwen-plus',
                url:      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
                keyHint:  'sk-... (DashScope Key)',
            },
            qwen_turbo: {
                provider: 'qwen',
                model:    'qwen-turbo',
                url:      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
                keyHint:  'sk-... (DashScope Key)',
            },
            qwen_max: {
                provider: 'qwen',
                model:    'qwen-max',
                url:      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
                keyHint:  'sk-... (DashScope Key)',
            },
            // Google Gemini（原生 REST API）
            gemini_2_flash: {
                provider: 'gemini',
                model:    'gemini-2.0-flash',
                url:      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
                keyHint:  'AIza... (Google AI Studio Key)',
            },
            gemini_1_5_pro: {
                provider: 'gemini',
                model:    'gemini-1.5-pro',
                url:      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent',
                keyHint:  'AIza... (Google AI Studio Key)',
            },
            gemini_1_5_flash: {
                provider: 'gemini',
                model:    'gemini-1.5-flash',
                url:      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
                keyHint:  'AIza... (Google AI Studio Key)',
            },
        };
        return configs[modelKey] || null;
    }

    /* ════════════════════════════════════════════════════
       TOOLBAR：模型切换联动 API Key 输入框
    ════════════════════════════════════════════════════ */
    _bindModelSelect() {
        const sel    = document.getElementById('modelSelect');
        const keyInp = document.getElementById('globalApiKey');

        const update = () => {
            const val = sel.value;
            if (val === 'local') {
                keyInp.classList.add('hidden');
            } else {
                keyInp.classList.remove('hidden');
                const cfg = this._getModelConfig(val);
                if (cfg) keyInp.placeholder = cfg.keyHint;
                // 边框颜色区分供应商
                keyInp.style.borderColor =
                    cfg?.provider === 'openai' ? '#89b4fa' :
                    cfg?.provider === 'qwen'   ? '#fab387' :
                    cfg?.provider === 'gemini'  ? '#a6e3a1' : '#45475a';
            }
        };

        sel.addEventListener('change', update);
        update(); // 初始化
    }

    /* ════════════════════════════════════════════════════
       AUTO GENERATE（从文本框拆分为逻辑链）
    ════════════════════════════════════════════════════ */
    async _autoGenerate() {
        const text     = document.getElementById('textInput').value.trim();
        const modelKey = document.getElementById('modelSelect').value;
        const apiKey   = document.getElementById('globalApiKey').value.trim();

        if (!text) { alert('请先在输入框中填写文本内容。'); return; }

        if (modelKey === 'local') {
            this._autoGenerateFallback(text);
            return;
        }

        if (!apiKey) {
            alert('请填写对应模型的 API Key。');
            return;
        }

        const cfg = this._getModelConfig(modelKey);
        if (!cfg) { this._autoGenerateFallback(text); return; }

        document.getElementById('loadingIndicator').classList.add('show');
        try {
            let raw = '';
            if (cfg.provider === 'gemini') {
                raw = await this._callGemini(cfg, apiKey, text);
            } else {
                // openai / qwen 均走 OpenAI-compatible 接口
                raw = await this._callOpenAICompat(cfg, apiKey, text);
            }
            this._spawnChainNodes(raw);
        } catch (err) {
            alert(`AI 拆分失败（${cfg.model}）：${err.message}\n\n已改用本地拆分。`);
            this._autoGenerateFallback(text);
        } finally {
            document.getElementById('loadingIndicator').classList.remove('show');
        }
    }

    /* ── OpenAI / Qwen（OpenAI-compatible）调用 ── */
    async _callOpenAICompat(cfg, apiKey, text) {
        const SYSTEM_PROMPT = '请按逻辑帮我将下面的文本拆分为具体的逻辑链条，并按顺序给每一个逻辑链条标数字。每行一条，格式严格为：\n1. 内容\n2. 内容\n...';
        const resp = await fetch(cfg.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: cfg.model,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user',   content: text },
                ],
                temperature: 0.3,
            }),
        });
        const data = await resp.json();
        if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
        return data.choices?.[0]?.message?.content ?? '';
    }

    /* ── Google Gemini 原生 REST 调用 ── */
    async _callGemini(cfg, apiKey, text) {
        const SYSTEM_PROMPT = '请按逻辑帮我将下面的文本拆分为具体的逻辑链条，并按顺序给每一个逻辑链条标数字。每行一条，格式严格为：\n1. 内容\n2. 内容\n...';
        const url  = `${cfg.url}?key=${encodeURIComponent(apiKey)}`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [
                    {
                        role: 'user',
                        parts: [{ text: SYSTEM_PROMPT + '\n\n' + text }],
                    },
                ],
                generationConfig: { temperature: 0.3 },
            }),
        });
        const data = await resp.json();
        if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
        // Gemini 响应路径
        return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    }

    /* ════════════════════════════════════════════════════
       本地拆分（智能版：识别步骤结构 + 提取标题与内容）
    ════════════════════════════════════════════════════ */
    _autoGenerateFallback(text) {
        // ── 步骤标记正则（匹配行首的各类编号格式）──
        // 支持：1. / 1、/ 1) / （1） / 第一步 / Step 1 / 一、 / 壹、 等
        const STEP_RE = /^[\s]*(?:Step\s*\d+[:.：]?|第\s*[一二三四五六七八九十百\d]+\s*[步条点项章节阶段][\s:.：]?|[（(]?\d+[）)）．.、:：]|[一二三四五六七八九十]+[、.．:：])\s*/i;

        const allLines = text.split('\n');
        const steps    = [];  // [{ title, lines[] }]

        let current = null;

        allLines.forEach(rawLine => {
            const line = rawLine.trimEnd();
            if (STEP_RE.test(line)) {
                // 新步骤开始
                if (current) steps.push(current);
                const titleRaw = line.replace(STEP_RE, '').trim();
                current = { title: titleRaw || null, lines: [] };
            } else {
                const trimmed = line.trim();
                if (!trimmed) return; // 跳过空行
                if (current) {
                    current.lines.push(trimmed);
                } else {
                    // 文本开头没有编号，作为前言或独立步骤
                    current = { title: null, lines: [trimmed] };
                }
            }
        });
        if (current) steps.push(current);

        // ── 如果没识别到编号格式，按标点/句子拆分 ──
        if (steps.length <= 1) {
            const sentences = text
                .split(/[。！？!?\n；;]+/)
                .map(s => s.trim())
                .filter(s => s.length > 1);

            if (sentences.length > 1) {
                // 多句：每句一个步骤
                const raw = sentences.map((s, i) => `${i + 1}. ${s}`).join('\n');
                this._spawnChainNodes(raw);
                return;
            }
            // 兜底：整段作为一个节点
            this._spawnChainNodes(`1. ${text.trim()}`);
            return;
        }

        // ── 将解析结果转为 spawnChainNodes 期望的结构化数组 ──
        const structured = steps.map((step, i) => {
            // 若步骤首行即标题，后续行为详情
            const title   = step.title || `步骤 ${i + 1}`;
            const content = step.lines.join('\n');
            return { title, content };
        });

        this._spawnChainNodes(null, structured);
    }

    /* ════════════════════════════════════════════════════
       生成链条节点（AI 和本地共用）
       - raw: AI 返回的纯文本（本地模式传 null）
       - structured: [{ title, content }] 数组（本地模式直接传）
    ════════════════════════════════════════════════════ */
    _spawnChainNodes(raw, structured = null) {
        // ── 解析阶段 ──
        let items = []; // [{ title, content }]

        if (structured) {
            // 本地拆分已经给出结构化数据，直接使用
            items = structured;
        } else if (raw) {
            // 解析 AI 返回的文本
            // 支持格式：
            //   "1. 标题\n   详细描述"（含缩进的多行）
            //   "1. 内容"（单行）
            //   "**1. 标题**\n内容"（Markdown 加粗）
            const NUMBERED = /^[\s]*(?:\*{0,2})[（(]?\d+[）)）．.、:：][\s]?(?:\*{0,2})\s*/;
            const rawLines = raw.split('\n');
            let cur = null;

            rawLines.forEach(line => {
                const stripped = line.replace(/^\*+|\*+$/g, '').trimEnd(); // 去除 Markdown **
                if (NUMBERED.test(stripped)) {
                    if (cur) items.push(cur);
                    const titlePart = stripped.replace(NUMBERED, '').trim();
                    // 检查是否有冒号分隔标题和内容（如 "1. 标题：内容"）
                    const colonIdx = titlePart.search(/[：:]/);
                    if (colonIdx > 0 && colonIdx < 20) {
                        cur = {
                            title:   titlePart.slice(0, colonIdx).trim(),
                            content: titlePart.slice(colonIdx + 1).trim(),
                        };
                    } else {
                        cur = { title: titlePart, content: '' };
                    }
                } else if (cur !== null) {
                    const trimmed = stripped.trim();
                    if (trimmed) cur.content += (cur.content ? '\n' : '') + trimmed;
                }
            });
            if (cur) items.push(cur);
        }

        if (items.length === 0) { alert('未能解析出任何逻辑链条，请检查文本格式。'); return; }

        // ── 布局参数 ──
        // 超过 6 个节点时自动换行（多行布局）
        const NODE_W   = 200;
        const GAP_X    = 260;
        const GAP_Y    = 180;
        const PER_ROW  = 6;
        const START_X  = 60;
        const START_Y  = 80;

        const prevIds = [];

        items.forEach((item, i) => {
            const col = i % PER_ROW;
            const row = Math.floor(i / PER_ROW);
            // 奇数行从右往左（蛇形布局），更符合流程图阅读习惯
            const isOddRow = row % 2 === 1;
            const colAdj  = isOddRow ? (PER_ROW - 1 - col) : col;

            const id = uid();
            this._createNode({
                id,
                x: START_X + colAdj * GAP_X,
                y: START_Y + row * GAP_Y,
                w: NODE_W,
                title:   item.title   || `步骤 ${i + 1}`,
                content: item.content || '',
            });

            // 连接逻辑：每个节点连接到前一个节点
            if (i > 0) this._createConnection(prevIds[i - 1], id);
            prevIds.push(id);
        });
    }

    /* ════════════════════════════════════════════════════
       SAVE / CLEAR
    ════════════════════════════════════════════════════ */
    _save() {
        const data = {
            version: 2,
            nodes: Object.values(this.nodes).map(nd => ({
                id:        nd.id,
                x:         nd.x,
                y:         nd.y,
                w:         nd.w  || nd.el.offsetWidth,
                h:         nd.h  || nd.el.offsetHeight,
                // 保存富文本 innerHTML（从 DOM 读取最新值，防止 blur 未触发）
                title:     nd.el?.querySelector('.node-title')?.innerHTML ?? nd.title ?? '',
                content:   nd.el?.querySelector('.node-text')?.innerHTML  ?? nd.content ?? '',
                completed: nd.completed || false,
                type:      nd.type      || 'normal',
                src:        nd.src        || null,  // 图片节点保存 base64
                bgColor:    nd.bgColor    || null,  // 节点自定义背景色
                pinVisible: nd.pinVisible !== undefined ? nd.pinVisible : true, // note 节点 pin 可见性
            })),
            connections: Object.values(this.connections).map(cn => ({
                id: cn.id, fromId: cn.fromId, toId: cn.toId,
                label: cn.label || '', style: cn.style || 'solid',
            })),
            pan:         { x: this.panX, y: this.panY },
            zoom:        this.zoom,
            colorConfig: { ...this.colorConfig },
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a    = document.createElement('a');
        a.href     = URL.createObjectURL(blob);
        a.download = 'blueprint.json';
        a.click();
    }

    /* ════════════════════════════════════════════════════
       OPEN（从 JSON 文件还原画布）
    ════════════════════════════════════════════════════ */
    _open() {
        document.getElementById('openFileInput').click();
    }

    _loadFromData(data) {
        // ── 1. 清空当前画布（静默，不记历史）──
        Object.keys(this.nodes).forEach(id => this.nodes[id].el.remove());
        this.nodes = {};
        this.svgGroup.innerHTML = '';
        this.connections = {};
        this.undoStack = [];

        // ── 2. 还原颜色配置 ──
        if (data.colorConfig) {
            Object.assign(this.colorConfig, data.colorConfig);
            this._applyColorConfig();
        }

        // ── 3. 还原视图 ──
        if (data.pan)  { this.panX = data.pan.x ?? 0; this.panY = data.pan.y ?? 0; }
        if (data.zoom) { this.zoom = data.zoom; }
        this._applyTransform();

        // ── 4. 还原节点 ──
        (data.nodes || []).forEach(nd => {
            if (nd.type === 'image') {
                const built = this._buildImageEl(nd.id, nd.src, nd.x, nd.y);
                if (nd.w) { built.el.style.width  = nd.w + 'px'; built.w = nd.w; }
                if (nd.h) { built.el.style.height = nd.h + 'px'; built.h = nd.h; }
            } else if (nd.type === 'note') {
                this._buildNoteEl({
                    id:         nd.id,
                    x:          nd.x,
                    y:          nd.y,
                    w:          nd.w || 240,
                    h:          nd.h || 160,
                    content:    nd.content    || '',
                    pinVisible: nd.pinVisible !== false,
                });
            } else {
                this._buildNodeEl({
                    id:        nd.id,
                    x:         nd.x,
                    y:         nd.y,
                    w:         nd.w || 200,
                    title:     nd.title     || '节点',
                    content:   nd.content   || '',
                    completed: nd.completed || false,
                    type:      nd.type      || 'normal',
                    bgColor:   nd.bgColor   || null,
                });
                // 若保存了高度，恢复（覆盖自适应）
                if (nd.h) this.nodes[nd.id].el.style.height = nd.h + 'px';
            }
        });

        // ── 4. 还原连线（节点渲染后才能计算 pin 位置）──
        setTimeout(() => {
            (data.connections || []).forEach(cn => {
                this._createConnectionSilent(cn.fromId, cn.toId, cn.id, cn.label || '', cn.style || 'solid');
            });
            this._redrawAllConnections();
        }, 30);
    }

    _clearAll() {
        Object.keys(this.nodes).forEach(id => {
            this.nodes[id].el.remove();
        });
        this.nodes       = {};
        this.svgGroup.innerHTML = '';
        this.connections = {};
    }

    /* ════════════════════════════════════════════════════
       IMAGE DROP
    ════════════════════════════════════════════════════ */
    _bindImageDrop() {
        const c = this.container;
        c.addEventListener('dragover', e => { e.preventDefault(); });
        c.addEventListener('drop', e => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (!file || !file.type.startsWith('image/')) return;
            const reader = new FileReader();
            reader.onload = ev => {
                const pos = this._toCanvas(e.clientX, e.clientY);
                this._createImageNode(ev.target.result, pos.x - 80, pos.y - 60);
            };
            reader.readAsDataURL(file);
        });

        // 粘贴图片
        document.addEventListener('paste', e => {
            const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
            if (!item) return;
            const blob   = item.getAsFile();
            const reader = new FileReader();
            reader.onload = ev => {
                const c2 = this._toCanvas(
                    this.container.clientWidth  / 2,
                    this.container.clientHeight / 2
                );
                this._createImageNode(ev.target.result, c2.x - 80, c2.y - 60);
            };
            reader.readAsDataURL(blob);
        });
    }

    _buildImageEl(id, src, x, y) {
        const el = document.createElement('div');
        el.className      = 'image-node';
        el.dataset.nodeId = id;
        el.style.cssText  = `left:${x}px; top:${y}px; width:240px; height:180px;`;

        // 图片主体
        const img = document.createElement('img');
        img.src = src;
        el.appendChild(img);

        // ── 右上角删除按钮 ──
        const delBtn = document.createElement('button');
        delBtn.className = 'image-del-btn';
        delBtn.title     = '删除图片';
        delBtn.textContent = '✕';
        delBtn.addEventListener('click', ev => {
            ev.stopPropagation();
            this._deleteNode(id);
        });
        el.appendChild(delBtn);

        // 8向 resize handles
        ['n','s','e','w','ne','nw','se','sw'].forEach(dir => {
            const h = document.createElement('div');
            h.className = `resize-handle ${dir}`;
            h.dataset.dir = dir;
            h.addEventListener('mousedown', ev => {
                if (ev.button !== 0) return;
                ev.stopPropagation();
                ev.preventDefault();
                const nd = this.nodes[id];
                this.resizing = {
                    id,
                    dir,
                    startMouseX: ev.clientX,
                    startMouseY: ev.clientY,
                    startX:  nd.x,
                    startY:  nd.y,
                    startW:  nd.el.offsetWidth,
                    startH:  nd.el.offsetHeight,
                };
            });
            el.appendChild(h);
        });

        // 拖拽图片节点（整个区域，但排除 resize handle 和删除按钮）
        el.addEventListener('mousedown', ev => {
            if (ev.button !== 0) return;
            if (ev.target.classList.contains('resize-handle')) return;
            if (ev.target.closest('.image-del-btn')) return;
            ev.stopPropagation();
            const nd = this.nodes[id];
            this.dragging = {
                id,
                startMouseX: ev.clientX,
                startMouseY: ev.clientY,
                startNodeX:  nd.x,
                startNodeY:  nd.y,
            };
        });

        this.nodeLayer.appendChild(el);

        const nd = { id, x, y, w: 240, h: 180, src, title: '图片', content: '', completed: false, type: 'image', el };
        this.nodes[id] = nd;
        return nd;
    }

    _createImageNode(src, x, y) {
        const id = uid();
        const nd = this._buildImageEl(id, src, x, y);

        // 图片加载完毕后调整初始尺寸（同时更新数据）
        nd.el.querySelector('img').onload = function() {
            const w = Math.min(this.naturalWidth,  400);
            const h = Math.min(this.naturalHeight, 300);
            nd.el.style.width  = w + 'px';
            nd.el.style.height = h + 'px';
            nd.w = w; nd.h = h;
        };

        // 记录撤销历史
        this._pushUndo({ type: 'create_node', id });
        return nd;
    }

    /* ════════════════════════════════════════════════════
       GROUP SYSTEM（框选分组）
    ════════════════════════════════════════════════════ */

    /* 预设的分组颜色池（UE Comment 风格） */
    _groupColors() {
        return [
            { bg:'rgba(137,180,250,0.12)', border:'#89b4fa', label:'#89b4fa' }, // 蓝
            { bg:'rgba(166,227,161,0.12)', border:'#a6e3a1', label:'#a6e3a1' }, // 绿
            { bg:'rgba(250,179,135,0.12)', border:'#fab387', label:'#fab387' }, // 橙
            { bg:'rgba(203,166,247,0.12)', border:'#cba6f7', label:'#cba6f7' }, // 紫
            { bg:'rgba(243,188,168,0.12)', border:'#f38ba8', label:'#f38ba8' }, // 红
            { bg:'rgba(249,226,175,0.12)', border:'#f9e2af', label:'#f9e2af' }, // 黄
            { bg:'rgba(137,220,235,0.12)', border:'#89dceb', label:'#89dceb' }, // 青
        ];
    }

    /* 绑定分组气泡弹窗（在 body 上监听关闭） */
    _bindGroupPopup() {
        // 点击空白区域关闭气泡
        document.addEventListener('mousedown', e => {
            const popup = document.getElementById('groupPopup');
            if (popup && !popup.contains(e.target)) {
                popup.remove();
            }
        }, true);
    }

    /* 显示「创建分组」气泡，出现在松开鼠标的位置 */
    _showGroupPopup(screenX, screenY, nodeIds) {
        // 移除旧的气泡
        const old = document.getElementById('groupPopup');
        if (old) old.remove();

        const colors = this._groupColors();
        const popup  = document.createElement('div');
        popup.id     = 'groupPopup';
        popup.className = 'group-popup';

        // 颜色选择器
        const colorRow = document.createElement('div');
        colorRow.className = 'group-popup-colors';
        let selectedColor = colors[0];
        const dots = colors.map((c, i) => {
            const dot = document.createElement('div');
            dot.className = 'group-color-dot' + (i === 0 ? ' active' : '');
            dot.style.background = c.border;
            dot.title = '';
            dot.addEventListener('click', () => {
                selectedColor = c;
                dots.forEach(d => d.classList.remove('active'));
                dot.classList.add('active');
            });
            return dot;
        });
        dots.forEach(d => colorRow.appendChild(d));

        // 标签输入
        const labelInput = document.createElement('input');
        labelInput.type  = 'text';
        labelInput.className = 'group-popup-input';
        labelInput.placeholder = '分组名称...';
        labelInput.value = '新分组';
        setTimeout(() => { labelInput.select(); }, 50);

        // 确认按钮
        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'group-popup-btn confirm';
        confirmBtn.textContent = '✓ 创建分组';
        confirmBtn.addEventListener('click', () => {
            this._createGroup(nodeIds, labelInput.value.trim() || '新分组', selectedColor);
            popup.remove();
        });
        labelInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') confirmBtn.click();
            if (e.key === 'Escape') popup.remove();
        });

        // 取消按钮
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'group-popup-btn cancel';
        cancelBtn.textContent = '✕ 取消';
        cancelBtn.addEventListener('click', () => popup.remove());

        const btnRow = document.createElement('div');
        btnRow.className = 'group-popup-btns';
        btnRow.appendChild(confirmBtn);
        btnRow.appendChild(cancelBtn);

        popup.innerHTML = `<div class="group-popup-title">📦 创建分组 (${nodeIds.size} 个节点)</div>`;
        popup.appendChild(colorRow);
        popup.appendChild(labelInput);
        popup.appendChild(btnRow);

        // 定位气泡（避免出边界）
        document.body.appendChild(popup);
        const pw = popup.offsetWidth  || 220;
        const ph = popup.offsetHeight || 140;
        const vw = window.innerWidth, vh = window.innerHeight;
        popup.style.left = Math.min(screenX + 8, vw - pw - 8) + 'px';
        popup.style.top  = Math.min(screenY + 8, vh - ph - 8) + 'px';
    }

    /* 实际创建分组 DOM 和数据 */
    _createGroup(nodeIds, label, colorScheme) {
        const PAD = 20; // 分组框与节点的内边距
        const gid = 'g' + uid();

        // ── 计算所有成员节点的包围盒 ──
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        nodeIds.forEach(id => {
            const nd = this.nodes[id];
            if (!nd) return;
            const w = nd.el.offsetWidth;
            const h = nd.el.offsetHeight;
            minX = Math.min(minX, nd.x);
            minY = Math.min(minY, nd.y);
            maxX = Math.max(maxX, nd.x + w);
            maxY = Math.max(maxY, nd.y + h);
        });

        const gx = minX - PAD;
        const gy = minY - PAD - 30; // 额外留出标题栏高度
        const gw = (maxX - minX) + PAD * 2;
        const gh = (maxY - minY) + PAD * 2 + 30;

        // ── 构建分组 DOM ──
        const el = document.createElement('div');
        el.className    = 'group-box';
        el.dataset.gid  = gid;
        el.style.cssText = `
            left:${gx}px; top:${gy}px;
            width:${gw}px; height:${gh}px;
            background:${colorScheme.bg};
            border-color:${colorScheme.border};
        `;

        // 标题栏
        const header = document.createElement('div');
        header.className   = 'group-header';
        header.style.color = colorScheme.label;
        header.innerHTML   = `
            <span class="group-label">${this._esc(label)}</span>
            <button class="group-delete-btn" title="解散分组">✕</button>
        `;

        // 双击标题改名
        const labelSpan = header.querySelector('.group-label');
        labelSpan.addEventListener('dblclick', ev => {
            ev.stopPropagation();
            const input = document.createElement('input');
            input.value     = label;
            input.className = 'group-label-edit';
            input.style.color = colorScheme.label;
            header.replaceChild(input, labelSpan);
            input.focus(); input.select();
            const finish = () => {
                label = input.value.trim() || label;
                labelSpan.textContent = label;
                this.groups[gid].label = label;
                header.replaceChild(labelSpan, input);
            };
            input.addEventListener('blur',   finish);
            input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
        });

        // 删除（解散）分组
        header.querySelector('.group-delete-btn').addEventListener('click', ev => {
            ev.stopPropagation();
            el.remove();
            delete this.groups[gid];
        });

        // 拖拽分组（通过标题栏）
        header.addEventListener('mousedown', ev => {
            if (ev.button !== 0) return;
            ev.stopPropagation();
            const grp = this.groups[gid];
            // 快照所有成员当前位置
            const snaps = [...grp.nodeIds]
                .filter(id => this.nodes[id])
                .map(id => ({ id, ox: this.nodes[id].x, oy: this.nodes[id].y }));
            this.draggingGroup = {
                groupId:     gid,
                startMouseX: ev.clientX,
                startMouseY: ev.clientY,
                startX:      grp.x,
                startY:      grp.y,
                memberSnaps: snaps,
            };
        });

        el.appendChild(header);

        // 分组框插到 nodeLayer 的最前面（在节点之下）
        this.nodeLayer.insertBefore(el, this.nodeLayer.firstChild);

        // ── 保存数据 ──
        this.groups[gid] = {
            id:      gid,
            label,
            color:   colorScheme,
            nodeIds: new Set(nodeIds),
            x: gx, y: gy, w: gw, h: gh,
            el,
        };
    }

    /* ════════════════════════════════════════════════════
       DEMO NODES
    ════════════════════════════════════════════════════ */
    _addDemoNodes() {
        const a = this._createNode({ id:'demo1', x:80,  y:120, title:'开始', content:'逻辑链条的起点' });
        const b = this._createNode({ id:'demo2', x:340, y:80,  title:'分析', content:'对输入数据进行逻辑分析' });
        const c = this._createNode({ id:'demo3', x:340, y:220, title:'处理', content:'执行核心处理流程' });
        const d = this._createNode({ id:'demo4', x:600, y:150, title:'输出', content:'逻辑链条的终点', completed:true });

        // 稍微延迟等节点渲染完高度
        setTimeout(() => {
            this._createConnection('demo1', 'demo2');
            this._createConnection('demo1', 'demo3');
            this._createConnection('demo2', 'demo4');
            this._createConnection('demo3', 'demo4');
        }, 50);
    }

    /* ════════════════════════════════════════════════════
       COLOR SYSTEM（颜色自定义系统）
    ════════════════════════════════════════════════════ */

    /* 颜色预设池（仅画布背景） */
    _colorPresets() {
        return {
            canvas: [
                { label: '浅灰（默认）', value: '#f7f8fa' },
                { label: '纯白',        value: '#ffffff' },
                { label: '蓝调白',      value: '#eef2ff' },
                { label: '绿调白',      value: '#f0fdf4' },
                { label: '暖米白',      value: '#faf9f6' },
                { label: '浅蓝灰',      value: '#f0f4f8' },
                { label: '深灰（暗色）', value: '#1e1e2e' },
                { label: '纯黑',        value: '#0d0d0d' },
            ],
        };
    }

    /* 节点单色预设（右键菜单用）—— 浅色 + 亮色系 */
    _nodeColorSwatches() {
        return [
            { label: '默认（白色）',  value: null },
            { label: '淡蓝',          value: '#dbeafe' },
            { label: '淡紫',          value: '#ede9fe' },
            { label: '淡绿',          value: '#d1fae5' },
            { label: '淡黄',          value: '#fef9c3' },
            { label: '淡橙',          value: '#ffedd5' },
            { label: '淡红',          value: '#fee2e2' },
            { label: '淡青',          value: '#cffafe' },
            { label: '淡粉',          value: '#fce7f3' },
            { label: '深蓝（暗色）',  value: '#1e3a5f' },
            { label: '深紫（暗色）',  value: '#2e1065' },
            { label: '深绿（暗色）',  value: '#064e3b' },
        ];
    }

    /* 根据节点背景色计算 header 背景 */
    _calcHeaderBg(hexColor) {
        try {
            const hex = hexColor.replace('#', '');
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            const lum = (0.299*r + 0.587*g + 0.114*b) / 255;
            if (lum > 0.55) {
                // 浅色背景：header 稍微暗一点（叠加 8% 黑色）
                const darken = v => Math.max(0, Math.round(v * 0.92));
                return `rgb(${darken(r)},${darken(g)},${darken(b)})`;
            } else {
                // 深色背景：header 更暗（降低 20% 亮度）
                const darken = v => Math.max(0, Math.round(v * 0.78));
                return `rgb(${darken(r)},${darken(g)},${darken(b)})`;
            }
        } catch {
            return '';
        }
    }

    /* 从 localStorage 恢复颜色配置 */
    _loadColorConfig() {
        try {
            const saved = localStorage.getItem('blueprintColorConfig');
            if (saved) {
                const parsed = JSON.parse(saved);
                // 过滤掉旧版本的深色 nodeBg 值（旧版本遗留），强制 null 回退 CSS
                if (parsed.nodeBg && parsed.nodeBg.match(/^#(1|2|0)[0-9a-f]{5}$/i)) {
                    parsed.nodeBg = null;
                }
                if (parsed.nodeHeader && parsed.nodeHeader.match(/^#(1|2|0)[0-9a-f]{5}$/i)) {
                    parsed.nodeHeader = null;
                }
                Object.assign(this.colorConfig, parsed);
            }
        } catch {}
        // 应用到 DOM（延迟，等 DOM 就绪）
        requestAnimationFrame(() => this._applyColorConfig());
    }

    /* 保存颜色配置到 localStorage */
    _saveColorConfig() {
        try {
            localStorage.setItem('blueprintColorConfig', JSON.stringify(this.colorConfig));
        } catch {}
    }

    /* 将颜色配置应用到 DOM */
    _applyColorConfig() {
        // 1. 画布背景色（保留网格线图案）
        this.container.style.backgroundColor = this.colorConfig.canvasBg;
        // 2. 所有有自定义颜色的节点重新应用（无自定义的保持 CSS 变量白色）
        Object.values(this.nodes).forEach(nd => {
            if (nd.type === 'image') return;
            if (nd.bgColor) {
                // 有自定义颜色：直接应用
                nd.el.style.background = nd.bgColor;
                const headerEl = nd.el.querySelector('.node-header');
                if (headerEl) headerEl.style.background = this._calcHeaderBg(nd.bgColor);
            } else {
                // 无自定义颜色：清除 inline style，回退到 CSS 变量（白色）
                nd.el.style.background = '';
                const headerEl = nd.el.querySelector('.node-header');
                if (headerEl) headerEl.style.background = '';
            }
        });
    }

    /* 为单个节点应用自定义颜色 */
    _applyNodeColor(id, color) {
        const nd = this.nodes[id];
        if (!nd || nd.type === 'image') return;
        const old = nd.bgColor;
        nd.bgColor = color; // null = 重置为 CSS 默认（白色）
        const headerEl = nd.el.querySelector('.node-header');
        if (color) {
            // 有自定义颜色：覆盖
            nd.el.style.background = color;
            if (headerEl) headerEl.style.background = this._calcHeaderBg(color);
            // 自动调整字色，确保可读性
            this._applyNodeTextColor(nd, color);
        } else {
            // 重置为默认：清除 inline style，回退 CSS 变量
            nd.el.style.background = '';
            nd.el.style.color = '';
            if (headerEl) {
                headerEl.style.background = '';
                headerEl.style.color = '';
            }
            nd.el.querySelectorAll('.node-title, .node-text').forEach(el => el.style.color = '');
        }
        // 记录撤销
        this._pushUndo({ type: 'edit_node', id, field: 'bgColor', oldVal: old, newVal: color });
    }

    /* 根据背景深浅自动调整节点字色（保证可读性） */
    _applyNodeTextColor(nd, hexColor) {
        try {
            const hex = hexColor.replace('#', '');
            const r = parseInt(hex.substring(0,2), 16);
            const g = parseInt(hex.substring(2,4), 16);
            const b = parseInt(hex.substring(4,6), 16);
            // 相对亮度公式
            const lum = (0.299*r + 0.587*g + 0.114*b) / 255;
            const textColor = lum < 0.45 ? '#f9fafb' : '#111827';
            const headerEl = nd.el.querySelector('.node-header');
            if (headerEl) headerEl.style.color = textColor;
            nd.el.querySelectorAll('.node-title, .node-text').forEach(el => el.style.color = textColor);
        } catch {}
    }

    /* ── 工具栏调色板面板 ── */
    _bindColorPalette() {
        const btn = document.getElementById('colorPaletteBtn');
        if (!btn) return;

        // 创建弹出面板
        const panel = document.createElement('div');
        panel.id = 'colorPalettePanel';
        panel.className = 'color-palette-panel';
        panel.innerHTML = `
            <div class="cp-header">
                <span><i class="fas fa-palette"></i> 画布配色</span>
                <button class="cp-close">✕</button>
            </div>
            <div class="cp-body">
                <div class="cp-section">
                    <div class="cp-label">🖼 画布背景色</div>
                    <div class="cp-swatches" data-target="canvasBg"></div>
                    <div class="cp-custom-row">
                        <label class="cp-custom-label">自定义：</label>
                        <input type="color" class="cp-color-input" data-target="canvasBg" value="#f7f8fa">
                        <span class="cp-hex-display" data-target="canvasBg">#f7f8fa</span>
                    </div>
                </div>
                <div class="cp-footer">
                    <button class="btn btn-secondary cp-reset-btn" style="font-size:12px;padding:5px 10px">
                        <i class="fas fa-undo"></i> 恢复默认
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        const presets = this._colorPresets();

        // 填充画布背景色色板
        const target = 'canvasBg';
        const swatchContainer = panel.querySelector(`.cp-swatches[data-target="${target}"]`);
        const colorInput      = panel.querySelector(`.cp-color-input[data-target="${target}"]`);
        const hexDisplay      = panel.querySelector(`.cp-hex-display[data-target="${target}"]`);

        // 同步当前颜色到 input
        const syncInput = () => {
            const cur = this.colorConfig.canvasBg || '#f7f8fa';
            colorInput.value       = cur;
            hexDisplay.textContent = cur;
            swatchContainer.querySelectorAll('.cp-swatch').forEach(s => {
                s.classList.toggle('active', s.dataset.color === cur);
            });
        };

        presets.canvas.forEach(preset => {
            const swatch = document.createElement('div');
            swatch.className     = 'cp-swatch';
            swatch.title         = preset.label;
            swatch.dataset.color = preset.value;
            swatch.style.background = preset.value;
            // 深色色板加一个边框避免在面板中不可见
            if (['#0d0d0d','#1e1e2e'].includes(preset.value)) {
                swatch.style.border = '2px solid #d1d5db';
            }
            swatch.addEventListener('click', () => {
                this.colorConfig.canvasBg = preset.value;
                this._applyColorConfig();
                this._saveColorConfig();
                syncInput();
            });
            swatchContainer.appendChild(swatch);
        });

        // 自定义颜色 input
        colorInput.addEventListener('input', () => {
            this.colorConfig.canvasBg = colorInput.value;
            hexDisplay.textContent = colorInput.value;
            this._applyColorConfig();
            this._saveColorConfig();
            swatchContainer.querySelectorAll('.cp-swatch').forEach(s => {
                s.classList.toggle('active', s.dataset.color === colorInput.value);
            });
        });

        syncInput();

        // 恢复默认
        panel.querySelector('.cp-reset-btn').addEventListener('click', () => {
            this.colorConfig = { canvasBg: '#f7f8fa', nodeBg: null, nodeHeader: null };
            this._applyColorConfig();
            this._saveColorConfig();
            syncInput();
        });

        // 关闭按钮
        panel.querySelector('.cp-close').addEventListener('click', () => {
            panel.classList.remove('show');
        });

        // 切换面板显示
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isShow = panel.classList.toggle('show');
            if (isShow) {
                // 定位到按钮下方
                const r = btn.getBoundingClientRect();
                panel.style.top  = (r.bottom + 8) + 'px';
                panel.style.right = (window.innerWidth - r.right) + 'px';
                panel.style.left = 'auto';
            }
        });

        // 点击外部关闭
        document.addEventListener('click', (e) => {
            if (!panel.contains(e.target) && e.target !== btn) {
                panel.classList.remove('show');
            }
        });
    }

    /* ── 右键上下文菜单（节点颜色） ── */
    /* ════════════════════════════════════════════════════
       NOTE 节点：创建入口
    ════════════════════════════════════════════════════ */
    _createNote({ id, x, y, w = 240, h = 160, content = '', pinVisible = true } = {}) {
        id = id || uid();
        const nd = this._buildNoteEl({ id, x, y, w, h, content, pinVisible });
        this._pushUndo({ type: 'add_note', id });
        return nd;
    }

    /* ════════════════════════════════════════════════════
       NOTE 节点：构建 DOM
    ════════════════════════════════════════════════════ */
    _buildNoteEl({ id, x, y, w = 240, h = 160, content = '', pinVisible = true } = {}) {
        const el = document.createElement('div');
        el.className     = 'note-node';
        el.dataset.nodeId = id;
        el.dataset.type   = 'note';
        el.style.left     = x + 'px';
        el.style.top      = y + 'px';
        el.style.width    = w + 'px';
        el.style.height   = h + 'px';
        el.style.zIndex   = 2;

        // ── 8 方向 Resize Handles ──
        ['n','s','e','w','ne','nw','se','sw'].forEach(dir => {
            const rh = document.createElement('div');
            rh.className     = `resize-handle ${dir}`;
            rh.dataset.dir   = dir;
            el.appendChild(rh);
        });

        // ── 删除按钮 ──
        const delBtn = document.createElement('button');
        delBtn.className = 'note-del-btn';
        delBtn.title     = '删除便签';
        delBtn.innerHTML = '<i class="fas fa-times"></i>';
        el.appendChild(delBtn);

        // ── 内容区 ──
        const area = document.createElement('div');
        area.className = 'note-content-area';

        // Markdown 预览区
        const preview = document.createElement('div');
        preview.className = 'note-preview';
        // 初始渲染
        if (content && typeof marked !== 'undefined') {
            preview.innerHTML = marked.parse(content);
        }
        area.appendChild(preview);

        el.appendChild(area);

        // ── Pins（默认显示，可由右键菜单切换）──
        const outputPin = document.createElement('div');
        outputPin.className    = 'pin output-pin';
        outputPin.dataset.nodeId = id;
        outputPin.style.visibility = pinVisible ? 'visible' : 'hidden';
        el.appendChild(outputPin);

        const inputPin = document.createElement('div');
        inputPin.className     = 'pin input-pin';
        inputPin.dataset.nodeId = id;
        inputPin.style.visibility = pinVisible ? 'visible' : 'hidden';
        el.appendChild(inputPin);

        // ── 存入 nodes ──
        this.nodeLayer.appendChild(el);
        const nd = { id, x, y, w, h, content, type: 'note', pinVisible, el };
        this.nodes[id] = nd;

        // ── 事件绑定 ──
        this._bindNoteEvents(nd, el, preview, area, delBtn);

        return nd;
    }

    /* ════════════════════════════════════════════════════
       NOTE 节点：事件绑定
    ════════════════════════════════════════════════════ */
    _buildNoteEditor(nd, area, preview) {
        // 创建 textarea（lazily）
        const editor = document.createElement('textarea');
        editor.className   = 'note-editor';
        editor.placeholder = '在此输入 Markdown 笔记…\n\n# 标题\n**粗体** *斜体* `代码`\n- 列表项';
        editor.value       = nd.content || '';
        area.replaceChild(editor, preview);
        nd.el.classList.add('editing');
        editor.focus();
        editor.setSelectionRange(editor.value.length, editor.value.length);
        return editor;
    }

    _commitNoteEdit(nd, area, editor, preview) {
        nd.content = editor.value;
        // Markdown 渲染
        if (typeof marked !== 'undefined') {
            preview.innerHTML = marked.parse(nd.content);
        } else {
            // fallback：纯文本
            preview.textContent = nd.content;
        }
        area.replaceChild(preview, editor);
        nd.el.classList.remove('editing');
        this._pushUndo({ type: 'edit_note', id: nd.id });
    }

    _bindNoteEvents(nd, el, preview, area, delBtn) {
        let editor = null;

        // 双击进入编辑模式
        el.addEventListener('dblclick', (ev) => {
            if (ev.target.closest('.resize-handle') || ev.target.closest('.pin')) return;
            if (nd.el.classList.contains('editing')) return;
            editor = this._buildNoteEditor(nd, area, preview);

            // 点击编辑器外部退出
            const onClickOutside = (e) => {
                if (!editor.contains(e.target) && !nd.el.contains(e.target)) {
                    this._commitNoteEdit(nd, area, editor, preview);
                    editor = null;
                    document.removeEventListener('mousedown', onClickOutside, true);
                }
            };
            // 使用 setTimeout 避免当前 dblclick 立即触发
            setTimeout(() => {
                document.addEventListener('mousedown', onClickOutside, true);
            }, 0);
        });

        // 删除按钮
        delBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this._pushUndo({ type: 'del_note', id: nd.id, snap: this._snapNote(nd.id) });
            this._removeNote(nd.id);
        });

        // 拖拽移动（整个 el，排除 resize、pin、editor）
        el.addEventListener('mousedown', (ev) => {
            if (ev.button !== 0) return;
            if (ev.target.closest('.resize-handle')) return;
            if (ev.target.closest('.pin'))           return;
            if (ev.target.closest('.note-del-btn'))  return;
            if (ev.target.closest('.note-editor'))   return;
            this.dragging = {
                id:          nd.id,
                startMouseX: ev.clientX,
                startMouseY: ev.clientY,
                startNodeX:  nd.x,
                startNodeY:  nd.y,
            };
        });

        // Resize（复用已有的 resize 逻辑，通过 data-dir 区分方向）
        el.querySelectorAll('.resize-handle').forEach(handle => {
            handle.addEventListener('mousedown', (ev) => {
                if (ev.button !== 0) return;
                ev.stopPropagation();
                ev.preventDefault();
                this.resizing = {
                    id:          nd.id,
                    dir:         handle.dataset.dir,
                    startMouseX: ev.clientX,
                    startMouseY: ev.clientY,
                    startX:      nd.x,
                    startY:      nd.y,
                    startW:      el.offsetWidth,
                    startH:      el.offsetHeight,
                };
            });
        });

        // Output pin 开始连线
        el.querySelector('.output-pin').addEventListener('mousedown', (ev) => {
            if (ev.button !== 0) return;
            ev.stopPropagation();
            ev.preventDefault();
            this._startConnect(nd.id);
        });

        // Input pin 阻止冒泡
        el.querySelector('.input-pin').addEventListener('mousedown', (ev) => {
            ev.stopPropagation();
        });
    }

    /* ── note 节点辅助方法 ── */
    _snapNote(id) {
        const nd = this.nodes[id];
        if (!nd) return null;
        return {
            id:         nd.id,
            x:          nd.x,
            y:          nd.y,
            w:          nd.el.offsetWidth,
            h:          nd.el.offsetHeight,
            content:    nd.content,
            pinVisible: nd.pinVisible,
            type:       'note',
        };
    }

    _removeNote(id) {
        const nd = this.nodes[id];
        if (!nd) return;
        // 删除关联连线
        Object.values(this.connections).forEach(cn => {
            if (cn.fromId === id || cn.toId === id) {
                cn.path && cn.path.remove();
                delete this.connections[cn.id];
            }
        });
        nd.el.remove();
        delete this.nodes[id];
    }

    /* ── note pin 显示/隐藏 ── */
    _setNotePinVisible(id, visible) {
        const nd = this.nodes[id];
        if (!nd || nd.type !== 'note') return;
        nd.pinVisible = visible;
        nd.el.querySelectorAll('.pin').forEach(p => {
            p.style.visibility = visible ? 'visible' : 'hidden';
        });
    }

    /* ════════════════════════════════════════════════════
       富文本浮动工具栏
    ════════════════════════════════════════════════════ */
    _bindRichToolbar() {
        const toolbar  = document.getElementById('richToolbar');
        const colorPicker = document.getElementById('richColorPicker');
        if (!toolbar) return;
        // 将 toolbar 引用挂到实例，方便 blur 事件隐藏
        this._richToolbar = toolbar;

        // ── 存储当前正在编辑的可编辑区和选区范围 ──
        let savedRange   = null;  // 工具栏按钮点击前保存的选区
        let activeEditor = null;  // 当前聚焦的 contenteditable 元素

        /* 保存选区（在工具栏 mousedown 前调用，防止 blur 清除选区） */
        const saveSelection = () => {
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0) {
                savedRange = sel.getRangeAt(0).cloneRange();
            }
        };

        /* 恢复选区 */
        const restoreSelection = () => {
            if (!savedRange) return;
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(savedRange);
        };

        /* 更新工具栏按钮激活态 */
        const updateButtonStates = () => {
            toolbar.querySelectorAll('.rt-btn[data-cmd]').forEach(btn => {
                const cmd = btn.dataset.cmd;
                try {
                    const active = document.queryCommandState(cmd);
                    btn.classList.toggle('rt-active', active);
                } catch(e) {}
            });
            // 更新颜色指示器底部颜色
            try {
                const color = document.queryCommandValue('foreColor');
                if (color && colorPicker) {
                    colorPicker.value = this._rgbToHex(color);
                }
            } catch(e) {}
        };

        /* 显示工具栏在选区上方 */
        const showToolbar = (sel) => {
            if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
                toolbar.style.display = 'none';
                return;
            }
            const range  = sel.getRangeAt(0);
            const rect   = range.getBoundingClientRect();
            if (!rect || rect.width === 0) { toolbar.style.display = 'none'; return; }

            toolbar.style.display = 'flex';
            updateButtonStates();

            // 计算位置：选区中点，悬浮在选区上方
            const tbW = toolbar.offsetWidth  || 260;
            const tbH = toolbar.offsetHeight || 36;
            let left  = rect.left + rect.width / 2 - tbW / 2;
            let top   = rect.top  - tbH - 8 + window.scrollY;

            // 防止超出视口
            left = Math.max(6, Math.min(left, window.innerWidth - tbW - 6));
            if (top < 4) top = rect.bottom + 8 + window.scrollY;

            toolbar.style.left = left + 'px';
            toolbar.style.top  = top  + 'px';
        };

        /* 监听全局选区变化 */
        document.addEventListener('selectionchange', () => {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
                // 若焦点在工具栏内，不要立即隐藏
                if (document.activeElement && toolbar.contains(document.activeElement)) return;
                toolbar.style.display = 'none';
                return;
            }
            // 检查选区是否在节点的可编辑区域内
            const anchor = sel.anchorNode;
            if (!anchor) { toolbar.style.display = 'none'; return; }
            const editableEl = anchor.nodeType === Node.TEXT_NODE
                ? anchor.parentElement?.closest('.node-title, .node-text')
                : anchor.closest?.('.node-title, .node-text');
            if (!editableEl) { toolbar.style.display = 'none'; return; }
            activeEditor = editableEl;
            showToolbar(sel);
        });

        /* 工具栏按钮点击（mousedown 阻止 blur，click 执行命令） */
        toolbar.addEventListener('mousedown', ev => {
            // 阻止默认 focus 行为，避免 contenteditable 失焦（从而清空选区）
            ev.preventDefault();
            saveSelection();
        });

        toolbar.querySelectorAll('.rt-btn[data-cmd]').forEach(btn => {
            btn.addEventListener('click', ev => {
                ev.preventDefault();
                restoreSelection();
                const cmd = btn.dataset.cmd;
                document.execCommand(cmd, false, null);
                updateButtonStates();
                // 内容已变化，同步到数据模型
                if (activeEditor) {
                    const nd = this._findNodeByEditable(activeEditor);
                    if (nd) {
                        const field = activeEditor.dataset.field;
                        nd[field] = activeEditor.innerHTML;
                    }
                }
                showToolbar(window.getSelection());
            });
        });

        /* 颜色选择器 */
        if (colorPicker) {
            // mousedown 阻止失焦
            colorPicker.addEventListener('mousedown', ev => {
                ev.stopPropagation();
                saveSelection();
            });
            colorPicker.addEventListener('input', ev => {
                restoreSelection();
                document.execCommand('foreColor', false, colorPicker.value);
                // 更新颜色图标底部色
                const icon = toolbar.querySelector('.rt-color-icon');
                if (icon) icon.style.borderBottom = `3px solid ${colorPicker.value}`;
                if (activeEditor) {
                    const nd = this._findNodeByEditable(activeEditor);
                    if (nd) {
                        const field = activeEditor.dataset.field;
                        nd[field] = activeEditor.innerHTML;
                    }
                }
                showToolbar(window.getSelection());
            });
            // 初始化颜色指示器
            const icon = toolbar.querySelector('.rt-color-icon');
            if (icon) icon.style.borderBottom = `3px solid ${colorPicker.value}`;
        }
    }

    /* 辅助：通过 contenteditable 元素找到对应的节点数据 */
    _findNodeByEditable(el) {
        const nodeEl = el.closest('[data-node-id]');
        if (!nodeEl) return null;
        return this.nodes[nodeEl.dataset.nodeId] || null;
    }

    /* 辅助：将 rgb(r,g,b) 或 rgba() 转为 #rrggbb */
    _rgbToHex(rgb) {
        if (!rgb || rgb === 'transparent') return '#cdd6f4';
        if (rgb.startsWith('#')) return rgb;
        const m = rgb.match(/\d+/g);
        if (!m || m.length < 3) return '#cdd6f4';
        return '#' + [m[0],m[1],m[2]].map(n => parseInt(n).toString(16).padStart(2,'0')).join('');
    }

    _bindContextMenu() {
        // 创建右键菜单 DOM
        const menu = document.createElement('div');
        menu.id = 'nodeContextMenu';
        menu.className = 'node-context-menu';
        menu.innerHTML = `
            <div class="ncm-title"><i class="fas fa-paint-brush"></i> 节点颜色</div>
            <div class="ncm-swatches"></div>
            <div class="ncm-divider"></div>
            <div class="ncm-custom-row">
                <label class="ncm-custom-label">自定义：</label>
                <input type="color" class="ncm-color-input">
                <span class="ncm-custom-hint" style="font-size:10px;color:var(--text-tertiary);margin-left:2px">实时预览</span>
            </div>
            <div class="ncm-divider"></div>
            <div class="ncm-item ncm-reset" data-action="reset">
                <i class="fas fa-times"></i> 重置为默认
            </div>
            <div class="ncm-confirm-bar hidden">
                <button class="ncm-btn-cancel">取消</button>
                <button class="ncm-btn-confirm">✓ 确认应用</button>
            </div>
        `;
        document.body.appendChild(menu);

        let menuTargetId   = null;
        let previewColor   = null;   // 当前预览色（尚未写入 bgColor）
        let originalColor  = null;   // 打开菜单前的原始色（用于取消回滚）

        /** 临时预览（不入撤销栈） */
        const previewNodeColor = (id, color) => {
            const nd = this.nodes[id];
            if (!nd) return;
            const hEl  = nd.el.querySelector('.node-header');
            if (color) {
                nd.el.style.background = color;
                if (hEl) hEl.style.background = this._calcHeaderBg(color);
                this._applyNodeTextColor(nd, color);
            } else {
                nd.el.style.background = '';
                if (hEl) { hEl.style.background = ''; hEl.style.color = ''; }
                nd.el.querySelectorAll('.node-title,.node-text').forEach(el => el.style.color = '');
            }
        };

        /** 显示/隐藏确认栏 */
        const confirmBar  = menu.querySelector('.ncm-confirm-bar');
        const showConfirm = (show) => confirmBar.classList.toggle('hidden', !show);

        // 填充色板（点击仅预览，不立即写入）
        const swatchContainer = menu.querySelector('.ncm-swatches');
        this._nodeColorSwatches().forEach(sw => {
            const el = document.createElement('div');
            el.className = 'ncm-swatch';
            el.title = sw.label;
            if (sw.value) {
                el.style.background = sw.value;
            } else {
                el.className += ' ncm-swatch-default';
                el.textContent = '默';
            }
            el.addEventListener('click', () => {
                if (!menuTargetId) return;
                // 取消其他色板选中
                swatchContainer.querySelectorAll('.ncm-swatch').forEach(s => s.classList.remove('ncm-selected'));
                el.classList.add('ncm-selected');
                previewColor = sw.value;
                previewNodeColor(menuTargetId, previewColor);
                showConfirm(previewColor !== originalColor);
            });
            swatchContainer.appendChild(el);
        });

        // 自定义颜色：input change 实时预览
        const customInput = menu.querySelector('.ncm-color-input');
        customInput.addEventListener('input', () => {
            if (!menuTargetId) return;
            previewColor = customInput.value;
            previewNodeColor(menuTargetId, previewColor);
            showConfirm(true);
        });

        // 确认：将预览色正式写入 bgColor + 入撤销栈
        menu.querySelector('.ncm-btn-confirm').addEventListener('click', () => {
            if (menuTargetId) this._applyNodeColor(menuTargetId, previewColor);
            menu.classList.remove('show');
        });

        // 取消：回滚到原始色，关闭菜单
        menu.querySelector('.ncm-btn-cancel').addEventListener('click', () => {
            if (menuTargetId) previewNodeColor(menuTargetId, originalColor);
            menu.classList.remove('show');
        });

        // 重置为默认（无需确认，直接应用）
        menu.querySelector('.ncm-reset').addEventListener('click', () => {
            if (menuTargetId) this._applyNodeColor(menuTargetId, null);
            menu.classList.remove('show');
        });

        // ── 便签节点专属菜单项：Pin 显示切换 ──
        const pinToggleDivider = document.createElement('div');
        pinToggleDivider.className = 'ncm-divider';
        pinToggleDivider.id = 'ncm-pin-divider';
        menu.appendChild(pinToggleDivider);

        const pinToggleItem = document.createElement('div');
        pinToggleItem.className = 'ncm-item ncm-pin-toggle';
        pinToggleItem.id = 'ncm-pin-toggle';
        pinToggleItem.innerHTML = '<i class="fas fa-project-diagram"></i> <span>隐藏连接 Pin</span>';
        menu.appendChild(pinToggleItem);

        pinToggleItem.addEventListener('click', () => {
            if (!menuTargetId) return;
            const nd = this.nodes[menuTargetId];
            if (!nd || nd.type !== 'note') return;
            this._setNotePinVisible(menuTargetId, !nd.pinVisible);
            menu.classList.remove('show');
        });

        // 右键监听：节点上
        this.nodeLayer.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const nodeEl = e.target.closest('[data-node-id]');
            if (!nodeEl) { menu.classList.remove('show'); return; }
            const id = nodeEl.dataset.nodeId;
            const nd = this.nodes[id];
            if (!nd || nd.type === 'image') { menu.classList.remove('show'); return; }

            menuTargetId  = id;
            originalColor = nd.bgColor || null;   // 记录原始色，供"取消"回滚
            previewColor  = originalColor;

            // 重置确认栏和色板高亮
            showConfirm(false);
            swatchContainer.querySelectorAll('.ncm-swatch').forEach(s => s.classList.remove('ncm-selected'));

            // 判断是否为 note 节点：隐藏颜色区域，显示 pin 切换
            const isNote = nd.type === 'note';
            menu.querySelector('.ncm-title').style.display       = isNote ? 'none' : '';
            menu.querySelector('.ncm-swatches').style.display     = isNote ? 'none' : '';
            menu.querySelector('.ncm-custom-row').style.display   = isNote ? 'none' : '';
            menu.querySelector('[data-action="reset"]').style.display = isNote ? 'none' : '';
            // 第一条分隔线（颜色区和 reset 之间）
            menu.querySelectorAll('.ncm-divider')[0].style.display = isNote ? 'none' : '';
            menu.querySelectorAll('.ncm-divider')[1].style.display = isNote ? 'none' : '';

            pinToggleDivider.style.display = isNote ? '' : 'none';
            pinToggleItem.style.display    = isNote ? '' : 'none';

            if (isNote) {
                // 更新 pin 切换文字
                pinToggleItem.querySelector('span').textContent =
                    nd.pinVisible ? '隐藏连接 Pin' : '显示连接 Pin';
            } else {
                // 同步当前颜色到 input（默认白色）
                customInput.value = nd.bgColor || '#ffffff';
            }

            // 定位
            menu.style.left = e.clientX + 'px';
            menu.style.top  = e.clientY + 'px';
            menu.classList.add('show');
            // 防止超出屏幕
            requestAnimationFrame(() => {
                const mr = menu.getBoundingClientRect();
                if (mr.right > window.innerWidth)  menu.style.left = (e.clientX - mr.width) + 'px';
                if (mr.bottom > window.innerHeight) menu.style.top  = (e.clientY - mr.height) + 'px';
            });
        });

        // 点击其他地方关闭菜单（视为"取消"——回滚预览）
        document.addEventListener('click', (e) => {
            if (menu.contains(e.target)) return;   // 点菜单内部不关闭
            if (menu.classList.contains('show') && menuTargetId) {
                previewNodeColor(menuTargetId, originalColor);  // 回滚
            }
            menu.classList.remove('show');
        });
        document.addEventListener('contextmenu', (e) => {
            // 如果不是在节点上右键，则关闭
            if (!e.target.closest('[data-node-id]')) menu.classList.remove('show');
        });
    }
}

/* ═══════════════════════════════════════════════════════
   启动
═══════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
    window.editor = new BlueprintEditor();
});
