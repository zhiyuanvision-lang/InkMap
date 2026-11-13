# 上架与收款手册

Inkmap 首次使用起可免登录试用 7 天，到期后需购买才能继续使用。Pro 由云帆平台管理账号权益，电脑端通过微信扫码一次性购买，正式买断价为 ¥29.90。已购买的用户可用同一账号在 VS Code、Cursor 和命令行中恢复权益。

## 配置收款

1. 按 ZhiyuanPlatform 仓库的收费服务部署说明配置数据库、HTTPS 路由和微信支付凭据，并在平台添加商品 `inkmap-pro` 和权益 `inkmap.pro`。
2. 客户端默认连接 `https://zhiyuanv.com`。测试环境可设置 `inkmap.billingOrigin` 或 `INKMAP_BILLING_ORIGIN`。先更新收费服务，再分发使用独立登录接口的 Codex 和 WorkBuddy 构建。包含插件内手机号登录的 VS Code/Cursor 构建还需要先在 ZhiyuanPlatform 仓库运行 `sh deploy/billing/smoke.sh https://zhiyuanv.com`，确认发送和验证接口已上线，再在插件中验收真实短信登录与权益同步。
3. 用测试账号从两个编辑器验证打开结账、扫码付款、自动解锁、恢复和退出。真实付款与全额退款验证完成后再开放商品。
4. 如果曾销售过独立激活码或需要手动开通终身会员，可在收费数据库中按购买者的云帆 `user_id` 写入已支付订单和授权记录：

   ```sql
   BEGIN;
   INSERT INTO billing_orders (id, user_id, product_id, entitlement, amount_fen, currency, status, paid_at)
   VALUES ('grant-<唯一编号>', '<云帆平台 user_id>', 'inkmap-pro', 'inkmap.pro', 2990, 'CNY', 'paid', now());

   INSERT INTO billing_grants (order_id, user_id, entitlement)
   VALUES ('grant-<唯一编号>', '<云帆平台 user_id>', 'inkmap.pro');
   COMMIT;
   ```
   写入后，用户在客户端点击「恢复 Pro 权益」并登录同一账号即可显示「Pro 终身会员」。

## 分发 Codex 桌面版

运行 `npm run package:codex` 生成 `dist/sidebars/inkmap-codex-desktop.zip`。发布前，用干净的 Codex 配置试装 ZIP，并在桌面端打开、编辑和保存一份 Markdown 示例。将 ZIP 作为资产上传到 [Inkmap GitHub Releases](https://github.com/zhiyuanvision-lang/InkMap/releases)，并附上 [Codex 桌面版安装说明](packages/codex/README.md)。

如果该版本设置为 GitHub 的最新正式版本，可分享固定地址 `https://github.com/zhiyuanvision-lang/InkMap/releases/latest/download/inkmap-codex-desktop.zip`。试用版本可直接分享该版本资产的下载地址。 [GitHub 下载链接说明](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)

## 发布编辑器插件

Cursor、Windsurf 等编辑器从 **Open VSX** 安装插件，VS Code 从 **Visual Studio Marketplace** 安装，两个都要发布。

### 每次发布前

```bash
npm run build && npm test                        # 全部测试
node packages/vscode/scripts/screenshots.mjs     # 更新商店截图（images/）
node packages/vscode/scripts/notices.mjs         # 更新第三方许可声明
```

更新 `packages/vscode/package.json` 的 `version` 和 `packages/vscode/CHANGELOG.md`。

### 商店页面中的图片

商店页面不能显示 README 中的相对路径图片，需要一个公开地址存放 `packages/vscode/images/` 和 `LICENSE.md`。可以把这个仓库公开（或单独建一个公开仓库只放这些文件），也可以放到 Cloudflare Pages 等静态托管。然后：

```bash
export INKMAP_IMAGES_URL=https://raw.githubusercontent.com/<用户名>/inkmap/main/packages/vscode/
export INKMAP_CONTENT_URL=https://github.com/<用户名>/inkmap/blob/main/packages/vscode/
npm run package:release -w inkmap-vscode         # 生成 packages/vscode/dist/inkmap.vsix
```

### Open VSX

1. 在 [open-vsx.org](https://open-vsx.org) 用 GitHub 登录，在个人设置中关联 Eclipse 账号并签署发布者协议（Publisher Agreement）。
2. 生成访问令牌（Access Token），创建命名空间（与 `publisher` 相同）：`npx ovsx create-namespace inkmap -p <令牌>`。
3. 发布：`npx ovsx publish packages/vscode/dist/inkmap.vsix -p <令牌>`。

Open VSX 允许付费和免费增值插件，付款、税务和退款由卖家自己负责。

### Visual Studio Marketplace

1. 用微软账号登录 [Marketplace 管理页](https://marketplace.visualstudio.com/manage)，创建发布者（ID 与 `publisher` 相同）。
2. 在 Azure DevOps 生成个人访问令牌（Personal Access Token），组织选「All accessible organizations」，权限选「Marketplace → Manage」。
3. 发布：`npx vsce publish --packagePath packages/vscode/dist/inkmap.vsix -p <令牌>`。

Marketplace 不支持付费上架，`pricing` 保持 `Free`，在商店说明中明确 7 天试用及到期付费。
