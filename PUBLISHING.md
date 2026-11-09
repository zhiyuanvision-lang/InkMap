# 上架与收款手册

Inkmap 分免费版和 Pro 终身会员（国内 ¥19.9，海外 $9.9）。“终身”指一次购买、永久使用，并包含之后的全部更新。

激活码离线校验：私钥签发，插件内置公钥校验，不需要服务器和账号。

## 0. 必须先做

1. **备份私钥**：把 `~/.inkmap/license-private.key` 存进密码管理器或加密盘。私钥丢失后无法再签发同一批公钥能识别的激活码；私钥泄露则任何人都能生成激活码。私钥和 `~/.inkmap/issued.csv` 都不进 Git。
2. **准备联系邮箱**：用于售后和找回激活码，填进 `services/license-worker/wrangler.jsonc` 的 `SUPPORT_EMAIL`。
3. **确定发布者 ID**：`packages/vscode/package.json` 的 `publisher` 目前是 `inkmap`，要和下面两个商店里注册的发布者 ID 一致；被占用就换一个，并同步修改。

## 1. 国内收款：爱发电

爱发电不能直接收海外付款（海外买家只能通过 PayPal 转账给平台管理员代付），所以只用于国内。

1. 注册爱发电创作者并完成实名认证，提现到支付宝或银行卡。
2. 新建「售卖商品」：名称「Inkmap Pro 终身会员」，价格 ¥19.9。说明可直接用插件 README 中的免费版与 Pro 对比表。
3. 发货方式选「自动回复 / 随机发放激活码」。生成一批激活码粘进去，每行一个：

   ```bash
   node scripts/license-issue.mjs --count 200 --channel afdian > afdian-codes.txt
   # 粘贴到爱发电后删除这个文件
   rm afdian-codes.txt
   ```

   每个激活码都会记在 `~/.inkmap/issued.csv`（编号、日期、渠道、备注、激活码），售后和停用时用。库存快用完时再生成一批。
4. 把商品链接填进 `packages/core/src/product.ts` 的 `PRODUCT.buyUrlCN`。

## 2. 海外收款：Creem + Cloudflare Worker

Creem 是“记录商户”（merchant of record），由它代收全球税费，支持中国大陆个人卖家提现到支付宝。

1. 注册 Creem，完成卖家认证，绑定支付宝收款。
2. 先在测试模式（Test Mode）建一次性付款商品「Inkmap Pro — Lifetime」，价格 $9.9。
3. 部署发码服务（需要一个 Cloudflare 账号，免费套餐足够）：

   ```bash
   cd services/license-worker
   npm install
   npx wrangler login
   # wrangler.jsonc 里填好 CREEM_PRODUCT_ID 和 SUPPORT_EMAIL
   npx wrangler secret put CREEM_API_KEY        # Creem → Developers → API key
   npx wrangler secret put LICENSE_PRIVATE_KEY  # 粘贴 ~/.inkmap/license-private.key 的内容
   npx wrangler deploy
   ```

4. 在 Creem 商品设置里，把付款成功后的跳转地址（Success URL）设为 `https://inkmap-license.<你的子域>.workers.dev/success`。
5. 用测试卡完成一次购买，确认跳转后显示 `INK1-` 开头的激活码，并能在插件里激活。刷新页面应显示同一个激活码。
6. 切换到正式模式（Live Mode）重建商品，更新 `CREEM_PRODUCT_ID` 和 `CREEM_API_KEY`，然后重新部署。
7. 把正式商品的付款链接填进 `PRODUCT.buyUrlIntl`。

发码服务只认 Creem 签名过的跳转链接，激活码由订单号推出，所以同一订单永远对应同一个编号。买家丢了激活码时，可以按订单号补发：

```bash
node scripts/license-issue.mjs --channel creem --order ord_xxx
```

## 3. 退款与停用

承诺 7 天内无理由全额退款（写在用户协议里）。退款后：

1. 在 `~/.inkmap/issued.csv` 中按订单号或激活码找到编号。Creem 订单的编号也可以这样算：`node -e 'import("./packages/core/src/license.ts").then(async m=>console.log(Buffer.from(await m.orderLicenseId("creem","ord_xxx")).toString("hex")))'`。
2. 把编号加进 `packages/core/src/license-key.ts` 的 `REVOKED_LICENSES`，随下个版本发布。发码服务也会拒绝为已停用的订单再次显示激活码（需重新部署）。

## 4. 发布插件

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

Marketplace 不支持付费上架，`pricing` 保持 `Free`；插件内显示广告时必须在说明中披露（README 的“免费版与 Pro”一节已说明）。

## 5. 广告源（可选）

免费版默认只轮播 Pro 功能介绍。如果接到赞助广告，把一个 HTTPS 的 JSON 地址填进 `PRODUCT.adFeedUrl`，内容是数组：

```json
[{ "id": "sponsor-1", "title": "标题", "text": "一句话介绍", "url": "https://…", "cta": "了解更多", "locale": "zh" }]
```

`locale` 可选（`zh` 或 `en`），只给对应语言的界面显示。插件每 6 小时最多获取一次，请求不带任何用户标识。
