# 服务器部署说明

> 本文档记录 `8.163.108.247` 上的部署结构，供后续更新与排障使用。
> **不记录任何密码**，凭证请单独保管。

## 一、访问地址

| 系统 | 公网地址 | 说明 |
|---|---|---|
| 智能库存补货主系统 | http://8.163.108.247 | nginx 反代 → 127.0.0.1:3000 |
| 仿真数据源控制台（主入口） | http://8.163.108.247/mock/ | nginx 反代 → 127.0.0.1:4100 |
| 仿真数据源控制台（备选） | http://8.163.108.247:8080 | 需安全组放行 8080 才可用 |

> 数据源当时只开放了 `/mock/` 通道，因为阿里云安全组默认只放行 80。
> 如需 `:8080` 直连，在「安全组 → 入方向」添加规则：协议 TCP、端口 8080、授权对象 0.0.0.0/0。

## 二、服务器环境

| 项目 | 值 |
|---|---|
| 系统 | Alibaba Cloud Linux 3.2104 (OpenAnolis) |
| 内核 | 5.10.134-19.1.al8.x86_64 |
| 内存 / 磁盘 | 896MB（含 1G swap）/ 30G（已用 25%） |
| Node.js | v22.22.2 → `/www/server/nodejs/node-v22.22.2-linux-x64/bin/node`，软链到 `/usr/local/bin/node` |
| nginx | 1.24.0（dnf 安装，需 `--disableexcludes=all`） |
| 宝塔面板 | 已存在，端口 8888，与本次部署互不干扰 |

## 三、目录结构

```
/www/wwwroot/dianshang/
├── server/                主系统后端
├── public/                主系统前端（原生 ESM + 本地 ECharts）
├── mock-data-service/     仿真数据源代码（零依赖）
├── data/inventory.db      SQLite 数据库
├── logs/                  运行日志（已配 logrotate，保留 7 天）
├── node_modules/          仅 express
├── .npmrc                 指向 npmmirror 镜像
└── package.json
```

## 四、服务管理

两个服务均由 systemd 托管，**已设置开机自启 + 崩溃自动重启**。

```bash
systemctl status  dianshang-app     # 主系统
systemctl restart dianshang-app
systemctl status  dianshang-mock    # 仿真数据源
systemctl restart dianshang-mock
systemctl status  nginx
```

查看日志：

```bash
tail -f /www/wwwroot/dianshang/logs/app.log
tail -f /www/wwwroot/dianshang/logs/app.err.log
tail -f /www/wwwroot/dianshang/logs/mock.log
```

## 五、配置文件位置

| 用途 | 路径 |
|---|---|
| nginx 站点配置 | `/etc/nginx/conf.d/dianshang.conf` |
| 主系统 service | `/etc/systemd/system/dianshang-app.service` |
| 数据源 service | `/etc/systemd/system/dianshang-mock.service` |
| 日志轮转 | `/etc/logrotate.d/dianshang` |

## 六、更新代码流程

在本地改完代码后，重新上传并重启即可（数据库不会被覆盖）：

```bash
# 本地打包（排除依赖与数据）
tar czf app.tar.gz server public mock-data-service package.json package-lock.json

# 上传
scp app.tar.gz root@8.163.108.247:/tmp/

# 服务器上解压并重启
ssh root@8.163.108.247
cd /www/wwwroot/dianshang
tar xzf /tmp/app.tar.gz
systemctl restart dianshang-app dianshang-mock
```

仅前端改动时，可以只传 `public/` 目录，无需重启（静态文件实时读取）。

## 七、已知设计与限制

1. **端口绑定**：两个 Node 服务只监听 `127.0.0.1`，公网流量统一经 nginx 进入，内部端口不对外暴露。
2. **SSE 支持**：nginx 对 `/api/.*/stream` 关闭了 `proxy_buffering`，否则实时推送会被缓冲卡住。
3. **数据源路径**：控制台页面已改为相对路径请求（`api/xxx`），因此 `/mock/` 与 `:8080` 两种入口都能正常工作。改动文件：`mock-data-service/public/console.html`。
4. **内存限制**：主系统 `--max-old-space-size=280`，数据源 `160`，防止 896MB 小内存机器被 OOM 杀掉。
5. **数据库**：部署时从本地导入了一份快照（63 个商品、45 个上游导入），采购单表为空属正常初始状态，演示时现场生成即可。

## 八、排障

| 现象 | 排查方向 |
|---|---|
| 502 Bad Gateway | `systemctl status dianshang-app`，看是否被 OOM 杀掉 |
| 页面 404 | 检查 nginx 配置是否被覆盖：`nginx -t` |
| 数据源显示离线 | 主系统读的是数据库里的 `http://127.0.0.1:4100`，确认 `dianshang-mock` 在跑 |
| 内存吃紧 | `free -m`，必要时下调两个 service 的 `max-old-space-size` |
| 安全组 | 80 已放行；8080 需手动添加规则 |

## 九、安全建议

1. **修改 root 密码**：部署过程中密码以明文出现在对话里，建议立即更换。
2. **改用密钥登录**：`ssh-copy-id` 上传公钥后，将 `/etc/ssh/sshd_config` 的 `PasswordAuthentication` 改为 `no`。
3. **宝塔面板 8888 端口**：如无需使用，建议在安全组关闭或加 IP 白名单。
4. **后续可加 HTTPS**：用 certbot 申请证书，nginx 加 443 server 块后即可启用。
