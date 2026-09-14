# 北京大学团支书培训班学分统计系统

## Linux 服务器部署

系统可在安装 Node.js 22.13 或更高版本的 Linux 服务器上运行。将整个项目复制到服务器，例如 `/opt/pku-credit-system`；不要复制本机的 `node_modules` 文件夹，服务器会自行安装依赖。

在服务器项目目录执行：

```bash
chmod +x start.sh
./start.sh
```

网站默认监听 `8787` 端口。生产环境建议用 Nginx 反向代理，配置示例在 `deploy/nginx-pku-credit-system.conf`；将其中的 `example.org` 改为实际域名后启用，并配置 HTTPS 证书。

若要在服务器重启后自动恢复运行，将 `deploy/pku-credit-system.service` 复制为 `/etc/systemd/system/pku-credit-system.service`，按实际的 Linux 用户和项目目录修改 `User`、`WorkingDirectory`、`ExecStart` 后执行：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pku-credit-system
sudo systemctl status pku-credit-system
```

在 `/etc/pku-credit-system.env` 中设置初始最高权限账号及 HTTPS Cookie。请使用真实的高强度密码，不要把该文件提交到仓库：

```bash
SUPER_ADMIN_1_USERNAME=pkuzzb
SUPER_ADMIN_1_PASSWORD=请设置高强度密码
SUPER_ADMIN_2_USERNAME=zhangtongwei
SUPER_ADMIN_2_PASSWORD=请设置另一个高强度密码
COOKIE_SECURE=true
```

数据保存在 `data/credits.db`。迁移到服务器时，请在本机先关闭网站，再一起复制 `data` 文件夹，以避免遗漏 SQLite 的临时日志文件。不要把 `data`、`.env` 或服务器密码提交到公共仓库。

## Windows 本机启动

双击 `start.bat`。已有数据库会继续使用数据库中的后台账号；全新部署须先通过环境变量设置最高权限账号。

浏览器打开 `http://localhost:8787`。若同一校园网内的其他设备无法连接，请右键以管理员身份运行 `开启局域网访问（管理员运行）.bat`，然后使用 `http://你的电脑局域网IP:8787` 访问。

## 当前数据与 Excel 导入

后台的“一键导入完整 Excel”支持本科组和硕博组工作表，并读取组别、联络员、个人信息、课程记录、原表总学分及退出备注。真实学员数据不包含在代码仓库中。

上述数据均归入“北京大学2025级团支书培训班”。学员查询和管理员登录都需先选择培训班；管理员可在“培训班管理”中新增培训班或修改名称。

- `1`：现场出勤。
- `2`：完成补修，与现场出勤取得相同课程学分。
- `2 2/3`：特殊课程，按 8 学分计算。
- 休学或退班学员保留在后台，但不计入总人数、平均学分和结业率。

课程标准已按当前规则设置：1031破冰 4 学分，开班仪式＋第一次实务技能培训 5 学分；其余课程在 0331耶鲁北大行及以前为 2 学分，之后为 3 学分。表格中截至0517第三次实务技能培训（含）的前四门课程设为必修，其余设为选修。

## 数据与安全

- 数据保存在 `data/credits.db`，请定期备份整个 `data` 文件夹。
- 后台账号和密码摘要保存在 `data/credits.db`；该数据库不会提交到代码仓库。
- 若网站开放到公网，请使用 HTTPS 反向代理，并通过服务器环境文件配置管理员初始密码和 `COOKIE_SECURE=true`。

## 更新代码但保留数据

仓库不包含 `data/`。服务器更新时可以拉取或覆盖程序代码，现有 `data/credits.db` 不会被 Git 操作覆盖。更新前仍建议备份 `data` 文件夹。
