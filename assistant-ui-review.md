# 办公助手输入与对话区域调整（0.10.1）

本轮具体对照了竞品的聊天区域源码和样式：

- [company-assistant-page.js](https://github.com/TianLin0509/ai-hub-huawei/blob/main/renderer/company-assistant-page.js)：`ca-scroll`、`ca-thread`、`ca-foot`、`ca-cbox` 和 `ca-cbar` 的组织。
- [company-assistant-page.css](https://github.com/TianLin0509/ai-hub-huawei/blob/main/renderer/styles/company-assistant-page.css)：消息气泡、独立消息滚动区、底部输入框、工具条与圆形发送按钮。

通过这些模板和样式检查了静态布局，未运行竞品完整后端。上一轮主要参考 PPT 工作区，聊天区的参考不够充分。

当前输入区将附件、资料核对、输出格式、语言和发送按钮合并在同一条工具栏中。附件放在工具栏上方，输入框保留一层外部焦点边框，减少嵌套边框和表单分隔线。键盘操作保持 Ctrl+Enter 发送、Enter 换行。

已有稿件时，当前一轮要求以用户气泡呈现，助手稿件保留编辑、版本、引用和导出操作。消息区独立滚动，输入框留在底部，输入的改稿要求不随稿件滚出窗口。这里仍使用任务和稿件版本模型；没有把它描述为完整的多轮消息历史。

验证覆盖附件导入、资料核对、较长稿件的滚动与输入框位置、Word 导出、稿件版本、未发送内容重启恢复，以及 820×620 的英文窗口。演示创作中的默认资料控件也经过复查。

桌面安装版已验证真实 Word 文件选择器、资料摘录、发送按钮连接状态和未发送内容的重启恢复。测试材料已移除，原有资料来源保持不变。实际界面截图在 `src-tauri/target/release/办公助手输入区预览.png` 和 `src-tauri/target/release/办公助手对话区预览.png`。
