# 🚀 节点思维导图工具 — GitHub Pages 部署指南

这是一个纯前端静态应用，无需服务器，直接托管在 GitHub Pages 即可免费访问。

---

## 📁 需要上传的文件（仅这 4 个）

```
index.html      ← 主页面
script.js       ← 核心逻辑
styles.css      ← 样式
.nojekyll       ← GitHub Pages 配置（告知跳过 Jekyll 处理）
```

> ⚠️ **不需要**上传 `.lua` 文件，那些是游戏服务器脚本，与本工具无关。

---

## 🛠️ 部署步骤（约 10 分钟）

### 第一步：创建 GitHub 仓库

1. 打开 [https://github.com](https://github.com)，登录你的账号
2. 点击右上角 **`+`** → **New repository**
3. 填写信息：
   - **Repository name**：`mindmap`（或任意名字，决定最终 URL）
   - **Visibility**：选 `Public`（Public 仓库才能用免费 Pages）
   - **不要**勾选 "Add a README file"
4. 点击 **Create repository**

---

### 第二步：上传文件

**方法 A：网页直接上传（推荐新手）**

1. 在新建的空仓库页面，点击 **"uploading an existing file"** 链接
2. 将以下 4 个文件拖入上传区：
   - `index.html`
   - `script.js`
   - `styles.css`
   - `.nojekyll`
3. 在页面底部填写 commit 信息（比如 `初始上传`）
4. 点击 **Commit changes**

**方法 B：使用 Git 命令行**

```bash
# 在项目目录下执行（注意替换为你的用户名和仓库名）
git init
git add index.html script.js styles.css .nojekyll
git commit -m "deploy: initial upload"
git branch -M main
git remote add origin https://github.com/你的用户名/mindmap.git
git push -u origin main
```

---

### 第三步：开启 GitHub Pages

1. 进入仓库主页，点击顶部 **Settings**（设置）
2. 左侧菜单找到 **Pages**（在 "Code and automation" 分类下）
3. 在 **"Source"** 区域：
   - Branch 选择：`main`
   - 目录选择：`/ (root)`
4. 点击 **Save**
5. 页面顶部会出现绿色提示：`Your site is published at https://你的用户名.github.io/mindmap/`

---

### 第四步：等待部署完成

- 首次部署通常需要 **1~3 分钟**
- 可以在 **Actions** 标签页查看部署进度
- 出现 ✅ 绿色勾即表示部署成功

---

## 🌐 访问地址格式

```
https://【你的GitHub用户名】.github.io/【仓库名】/
```

**示例：**
```
https://zhangsan.github.io/mindmap/
```

将这个链接分享给任何人，他们无需安装任何东西，直接在浏览器打开即可使用。

---

## 🔄 后续更新

每次修改文件后，重新上传到 GitHub 即可（覆盖旧文件），1~2 分钟后网页自动更新。

---

## ❓ 常见问题

| 问题 | 解决方法 |
|------|---------|
| 打开是 404 页面 | 确认 `index.html` 在仓库根目录，等待 1~3 分钟 |
| 样式丢失（纯文字） | 确认 `.nojekyll` 文件已上传 |
| Pages 选项不存在 | 确认仓库是 `Public`（私有仓库需要 Pro 账号） |
| 链接打不开 | 在 Settings > Pages 页面重新保存一次 |

---

## 💾 关于数据存储

本工具使用浏览器 **localStorage** 存储数据，这意味着：

- ✅ 数据保存在**每个人自己的浏览器**中
- ✅ 关闭页面不会丢失数据
- ⚠️ 换一台电脑/浏览器，数据不会同步
- ⚠️ 清除浏览器缓存会丢失数据

**建议定期使用工具内的「导出」功能备份数据。**
