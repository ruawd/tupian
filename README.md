# 🖼️ 随机图片 API

一个简单的随机图片服务，支持多种图片格式，自动分类横屏/竖屏图片。

## ✨ 功能特点

- 🎲 随机返回横屏或竖屏图片
- 📱 根据设备类型（手机/电脑）自动选择合适的图片
- 🖼️ 支持 WebP、AVIF、JPEG、PNG、GIF 等多种格式
- 📂 自动分类：把图片放到 `inbox` 目录，自动按宽高比分类
- 👀 实时监听：添加新图片后自动刷新列表

## 🚀 快速开始

### 安装

```bash
npm install
```

### 启动

```bash
npm start
```

服务器默认运行在 `http://localhost:3122`

## 📖 API 使用

| 接口 | 说明 |
|------|------|
| `/pic?img=h` | 随机横屏图片 |
| `/pic?img=v` | 随机竖屏图片 |
| `/pic?img=ua` | 根据设备自动选择 |
| `/refresh` | 手动刷新图片列表 |
| `/classify` | 手动触发分类 |

### 示例

```html
<!-- 在网页中使用 -->
<img src="https://your-domain.com/pic?img=h" alt="随机横屏图片">

<!-- 根据设备自动选择 -->
<img src="https://your-domain.com/pic?img=ua" alt="随机图片">
```

## 📁 目录结构

```
├── server.js        # 主服务
├── package.json
└── ri/
    ├── inbox/       # 📥 待分类（自动分类到 h 或 v）
    ├── h/           # 横屏图片
    └── v/           # 竖屏图片
```

## 🔧 添加图片

### 方式一：自动分类（推荐）

把图片放到 `ri/inbox/` 目录，系统会自动：
1. 读取图片尺寸
2. 宽 ≥ 高 → 移动到 `ri/h/`
3. 高 > 宽 → 移动到 `ri/v/`

### 方式二：手动分类

直接把图片放到对应目录：
- 横屏图片 → `ri/h/`
- 竖屏图片 → `ri/v/`

## 🌐 部署到 VPS

```bash
# 克隆仓库
git clone https://github.com/Ruawd/tupian.git
cd tupian

# 安装依赖
npm install

# 启动服务
npm start
```

### 使用 PM2 后台运行

```bash
npm install -g pm2
pm2 start server.js --name "pic-api"
pm2 save
```

## 📝 更新图片

### 本地上传到 GitHub

```bash
git add -A
git commit -m "添加新图片"
git push
```

### VPS 拉取更新

```bash
git pull
```

## ⚙️ 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 3122 | 服务端口 |

## 📄 License

GPL-3.0
