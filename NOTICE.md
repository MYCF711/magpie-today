# 版权声明

本插件 MIT 许可，正文见 `LICENSE`。

## 衍生的部分

| 来源 | 许可 | 用了什么 |
|---|---|---|
| [MYCF711/magpie-plugin-template](https://github.com/MYCF711/magpie-plugin-template) | MIT | 插件骨架（九个钩子的形状、`src/self-register.mjs` 自注册、README/CHANGELOG 结构） |
| [MYCF711/magpie-freebuff-plugin](https://github.com/MYCF711/magpie-freebuff-plugin) | MIT | OpenAI 形状响应的合成方式、SSE 写出方式、工具配对校验思路 |

## 不含第三方的代码

`src/desktop.mjs` 的 DPAPI 解密是用 Node 内置 `crypto` + Windows 系统 API（`System.Security.Cryptography.ProtectedData`）自己写的，
没有引入任何第三方加密库。

## 关于 Today

Today（`todayai.cn`）与本插件无关联。插件不包含、不重分发 Today 的任何二进制或代码，
只在运行时访问用户自己机器上已安装的客户端所留下的登录态，并调用 Today 的公开 HTTP 接口。
"Today"、"ToBot" 等名称归 TODAY AI PTE. LTD. 所有。
