# ai-app-panel — 原生运行包（无 Docker）

自包含应用包：自带 glibc 版 Node 22 二进制、服务端/前端和 PostgreSQL 迁移，
解压即跑，**不需要 Docker、不需要安装 Node**。需要可连接的 PostgreSQL 17
数据库和 `python3`（沙箱运行时；飞牛 fnOS / Debian 系系统自带）。
本形态不内置 PostgreSQL 服务；开发、测试与生产均通过 `DATABASE_URL` 连接 PostgreSQL。

> 平台预置 Python 框架（flask）由 `start.sh` 启动时自检补装到数据目录
> `python-libs/`（需要宿主 python3 带 pip——缺 pip 时脚本会先尝试 ensurepip，
> 仍不行请 `apt install python3-pip`；需要宿主可访问 pip 源，可用环境变量
> `PIP_INDEX_URL` 指定国内镜像；补装失败不阻断启动，flask 类 persistent 包会
> 503 并在日志留线索）。
> .awpk 包自身的第三方依赖走 manifest `requirements` 声明制，上传时自动
> 安装（同样经宿主 pip，装到应用数据目录，平台升级不丢）。

## 快速开始

```bash
tar -xzf ai-app-panel-native_<版本>_linux_<arch>.tar.gz
cd ai-app-panel-native_<版本>_linux_<arch>
DATABASE_URL='postgresql://ai_app_panel:strong_random_password@127.0.0.1:5432/ai_app_panel' \
  ADMIN_INITIAL_PASSWORD='你的初始密码' ./start.sh  # 前台启动，Ctrl-C 停止
```

- 启动前设置 `DATABASE_URL`，例如
  `postgresql://ai_app_panel:密码@127.0.0.1:5432/ai_app_panel`；数据库需预先创建，
  连接用户需拥有创建表/索引的权限，服务启动时会自动应用 `drizzle-pg/` 迁移。
- 服务地址 `http://<主机>:8080`（`PORT` 可改；HTTPS 口 8443）
- 数据目录默认在包内 `data/`（`DATA_DIR` 可改到独立数据盘）
- 首次启动用 `ADMIN_INITIAL_PASSWORD` 设定管理员密码；不设则容器日志语义改为
  stdout 打印一次性凭据（首次登录后自动失效）

## 生产部署（systemd，推荐）

```bash
sudo useradd -r -u 10001 -s /usr/sbin/nologin ai-app-panel || true
sudo mkdir -p /opt/ai-app-panel /var/lib/ai-app-panel
sudo tar -xzf ai-app-panel-native_<版本>_linux_<arch>.tar.gz -C /opt/ai-app-panel --strip-components=1
sudo chown -R ai-app-panel:ai-app-panel /opt/ai-app-panel /var/lib/ai-app-panel
sudo install -o root -g ai-app-panel -m 0640 /dev/null /etc/ai-app-panel.env
```

编辑 `/etc/ai-app-panel.env`，至少设置 `DATABASE_URL=postgresql://...` 指向全新空数据库；
该文件应只允许 root 写入，并仅授予服务组读取权限。

`/etc/systemd/system/ai-app-panel.service`：

```ini
[Unit]
Description=ai-app-panel
After=network.target

[Service]
User=ai-app-panel
Group=ai-app-panel
WorkingDirectory=/opt/ai-app-panel
Environment=DATA_DIR=/var/lib/ai-app-panel
EnvironmentFile=/etc/ai-app-panel.env
Environment=ADMIN_INITIAL_PASSWORD=CHANGE_ME_FIRST_BOOT
ExecStart=/opt/ai-app-panel/start.sh
Restart=on-failure
RestartSec=3

# 可选加固（沙箱包代码在宿主进程外运行，按需启用）
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=/var/lib/ai-app-panel

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now ai-app-panel
journalctl -u ai-app-panel -f        # 首次启动日志里有管理员凭据
```

## 安全基线（与 Docker 形态同一条红线）

**开放注册 + 允许用户上传包的部署必须以非特权用户运行**（上面的
`User=aap` 即此目的）：沙箱进程级硬隔离未实装，包代码可读「同用户可访问
的文件系统」——用专用低权用户跑服务，包能摸到的就只有数据目录。
Docker 形态的 `SANDBOX_UID/GID=10001` 在原生形态下由 systemd `User=` 等价承担。

## 已知差异（相对 Docker 形态）

- 沙箱包需要额外 Python 库（如示例 ip-analyzer 用 flask）时，需在主机
  `pip install`/`apt install python3-flask`——镜像内预装的部分不再自带
- 升级 = 解压新版本包替换程序文件（数据目录勿动）；无镜像版本管理
- fnOS 应用中心对「非 Docker 类」包的支持待与官方文档核实（fpk README
  待确认清单）；当前以 systemd / 手动方式运行，不改用统一网关桌面入口
