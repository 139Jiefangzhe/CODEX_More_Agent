对项目进行安全审计：

$ARGUMENTS

检查项：
1. 依赖漏洞扫描（运行 npm audit / pip audit）
2. 硬编码密钥和 token 检测
3. OWASP Top 10 合规检查
4. Docker 镜像安全（如适用）
5. 认证授权配置审查
6. CORS/CSP/HTTPS 配置

输出：安全报告 + 风险矩阵 + 修复优先级
