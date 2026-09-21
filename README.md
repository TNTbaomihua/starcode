# 追星消费记账本

面向追星人群的**纯本地离线**消费记账 PWA。无需登录、不联网、不付费，所有明星档案、账单、图片凭证全部保存在设备浏览器（IndexedDB）中。

## 功能

- **明星档案**：自定义昵称 + 上传头像，卡片式列表，可编辑 / 删除（删除时可选择「连账单一起删」或「账单保留为无归属」）
- **记账**：所属明星 → 消费分类 → 名称 / 价格 / 日期 / 备注，支持**相册上传**与**拍照上传**图片凭证（最多 9 张，超 5MB 自动压缩，可预览 / 删除）
- **分类**：全局共用，内置 8 类（演唱会、交通费、酒店费、代言周边、潮牌、文化周边、助农产品、其他），支持任意自定义新增 / 改名 / 删除
- **统计（双模式）**：
  - 单个明星统计：该明星全年总额、分类柱状图 / 占比饼图 + 分项列表、月度趋势、全年流水
  - 全部总统计：年度总支出、各消费大类占比、各明星开销对比、Top 5、全部流水汇总
  - 年份可切换（本年 / 去年 / 自定义）
- **数据安全**：JSON 一键导出备份、存储配额超限提醒、金额两位小数无浮点误差

## 技术栈

原生 HTML + CSS + JavaScript，零依赖、零构建步骤。

- 数据存储：IndexedDB（`idols` / `records` / `categories` 三张表）
- 用户资料：localStorage
- 图表：原生 Canvas 手绘（柱状图 / 折线图 / 饼图 / 环形图），适配深色主题
- 离线：Service Worker（页面网络优先 + 静态资源缓存优先 + 版本化更新）
- 图片处理：`createImageBitmap` 读取 EXIF 方向自动纠正、HEIC 检测提示、大图压缩

## 目录结构

```
.
├── index.html               # 页面结构（3 个 Tab + 各类弹层）
├── style.css                # 深黑 + 冷紫渐变主题样式
├── app.js                   # 全部业务逻辑（存储、渲染、图表、交互）
├── manifest.json            # PWA 清单（可安装到主屏幕）
├── sw.js                    # Service Worker 离线缓存
├── icons/                   # PWA 图标（192 / 512 / maskable）
├── make_icons.py            # 图标生成脚本（Python + Pillow，可选）
└── .nojekyll                # GitHub Pages 必需（阻止 Jekyll 处理）
```

## 部署到 GitHub Pages

1. 新建一个 GitHub 仓库（例如 `star-expense`），**Public**
2. 把本目录所有文件上传到仓库根目录（保持 `index.html` 在根目录，不要多套一层文件夹）
   - 命令行方式：
     ```bash
     git init
     git add .
     git commit -m "feat: 追星消费记账本"
     git branch -M main
     git remote add origin https://github.com/<你的用户名>/star-expense.git
     git push -u origin main
     ```
3. 仓库页面 → **Settings → Pages** → Source 选 **Deploy from a branch** → Branch 选 **main**、目录选 **/(root)** → Save
4. 等 1~2 分钟，访问：`https://<你的用户名>.github.io/star-expense/`

> 本项目所有资源路径均为相对路径（`./`），可直接放在仓库子路径下运行，无需改配置。

## 安装到手机 / 桌面

- **iPhone**：用 **Safari** 打开链接 → 底部「分享」→「添加到主屏幕」
- **Android**：用 **Chrome** 打开 → 右上角 ⋮ →「安装应用」（或点页面底部安装横幅）
- **电脑**：Chrome / Edge 地址栏右侧的安装图标 ⊕

安装后以独立窗口全屏运行，断网也能用。

## 注意事项

- 数据保存在**当前网址**的浏览器存储里：从原网址换到 GitHub Pages 网址属于**不同来源**，数据不会自动带过去。请先在原地址「设置 → 导出全部数据（JSON 备份）」保存一份。
- 清除浏览器数据 / 卸载浏览器会一并抹掉记录，建议每月导出一份 JSON 备份。
- iOS 无痕模式下浏览器禁止写入 IndexedDB，App 会给出提示，请用普通模式打开。
- 微信内置浏览器兼容性较差，建议点右上角「⋯ → 在浏览器中打开」。
