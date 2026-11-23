use crate::codex::AgentEngine;
use serde::Serialize;
use serde_json::Value;
use std::{fs::File, io::Read, path::Path};
use tauri::ipc::Channel;

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentEvent {
    Text {
        text: String,
        replace: bool,
    },
    Tool {
        id: String,
        action: &'static str,
        target: String,
        state: &'static str,
    },
    Finished {
        id: String,
        failed: bool,
    },
}

pub struct AgentStream<'a> {
    file: File,
    channel: &'a Channel<Vec<AgentEvent>>,
    engine: AgentEngine,
    workspace: Option<&'a Path>,
    line: Vec<u8>,
    skipping: bool,
    claude_result: Option<Vec<u8>>,
    new_message: bool,
}

const MAX_LINE: usize = 1024 * 1024;
const MAX_DRAIN: usize = 1024;

impl<'a> AgentStream<'a> {
    pub fn new(
        file: File,
        channel: &'a Channel<Vec<AgentEvent>>,
        engine: AgentEngine,
        workspace: Option<&'a Path>,
    ) -> Self {
        Self {
            file,
            channel,
            engine,
            workspace,
            line: Vec::new(),
            skipping: false,
            claude_result: None,
            new_message: true,
        }
    }

    pub fn poll(&mut self) -> bool {
        let mut bytes = [0u8; 64 * 1024];
        let Ok(size) = self.file.read(&mut bytes) else {
            return false;
        };
        if size == 0 {
            return false;
        }
        let mut events = Vec::new();
        for part in bytes[..size].split_inclusive(|value| *value == b'\n') {
            let complete = part.ends_with(b"\n");
            if !self.skipping {
                if self.line.len() + part.len() <= MAX_LINE {
                    self.line.extend_from_slice(part);
                } else {
                    self.line.clear();
                    self.skipping = true;
                }
            }
            if complete {
                if !self.skipping {
                    self.decode_line(&mut events);
                }
                self.skipping = false;
            }
        }
        if !events.is_empty() {
            let _ = self.channel.send(events);
        }
        true
    }

    pub fn finish(mut self) -> Option<Vec<u8>> {
        for _ in 0..MAX_DRAIN {
            if !self.poll() {
                break;
            }
        }
        if !self.line.is_empty() && !self.skipping {
            let mut events = Vec::new();
            self.decode_line(&mut events);
            if !events.is_empty() {
                let _ = self.channel.send(events);
            }
        }
        self.claude_result
    }

    fn decode_line(&mut self, events: &mut Vec<AgentEvent>) {
        if let Ok(value) = serde_json::from_slice::<Value>(&self.line) {
            match self.engine {
                AgentEngine::Codex => self.codex_event(&value, events),
                AgentEngine::Claude => self.claude_event(&value, events),
            }
        }
        self.line.clear();
    }

    fn codex_event(&self, value: &Value, events: &mut Vec<AgentEvent>) {
        let kind = value["type"].as_str().unwrap_or_default();
        if !matches!(kind, "item.started" | "item.updated" | "item.completed") {
            return;
        }
        let item = &value["item"];
        let Some(id) = item["id"].as_str() else {
            return;
        };
        let state = if kind != "item.completed" {
            "running"
        } else if item["status"].as_str() == Some("failed")
            || item["exit_code"].as_i64().is_some_and(|code| code != 0)
        {
            "failed"
        } else {
            "done"
        };
        let (action, target) = match item["type"].as_str() {
            Some("agent_message") if kind == "item.completed" => {
                if let Some(text) = item["text"].as_str().filter(|text| !text.is_empty()) {
                    events.push(AgentEvent::Text {
                        text: text.chars().take(32_000).collect(),
                        replace: true,
                    });
                }
                return;
            }
            Some("command_execution") => ("command", String::new()),
            Some("file_change") => (
                "write",
                self.path_label(item["changes"][0]["path"].as_str().unwrap_or_default()),
            ),
            Some("mcp_tool_call") => ("mcp", self.label(item["tool"].as_str().unwrap_or_default())),
            Some("web_search") => ("search", String::new()),
            _ => return,
        };
        events.push(AgentEvent::Tool {
            id: id.to_owned(),
            action,
            target,
            state,
        });
    }

    fn claude_event(&mut self, value: &Value, events: &mut Vec<AgentEvent>) {
        match value["type"].as_str() {
            Some("stream_event") => {
                let event = &value["event"];
                match event["type"].as_str() {
                    Some("message_start") => self.new_message = true,
                    Some("content_block_start") if event["content_block"]["type"] == "tool_use" => {
                        self.claude_tool(&event["content_block"], events);
                    }
                    Some("content_block_delta") if event["delta"]["type"] == "text_delta" => {
                        if let Some(text) = event["delta"]["text"]
                            .as_str()
                            .filter(|text| !text.is_empty())
                        {
                            events.push(AgentEvent::Text {
                                text: text.chars().take(32_000).collect(),
                                replace: std::mem::replace(&mut self.new_message, false),
                            });
                        }
                    }
                    _ => {}
                }
            }
            Some("assistant" | "user") => {
                if let Some(blocks) = value["message"]["content"].as_array() {
                    for block in blocks {
                        match block["type"].as_str() {
                            Some("tool_use") => self.claude_tool(block, events),
                            Some("tool_result") => {
                                if let Some(id) = block["tool_use_id"].as_str() {
                                    events.push(AgentEvent::Finished {
                                        id: id.to_owned(),
                                        failed: block["is_error"] == true,
                                    });
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            Some("result") => self.claude_result = Some(self.line.clone()),
            _ => {}
        }
    }

    fn claude_tool(&self, block: &Value, events: &mut Vec<AgentEvent>) {
        let (Some(id), Some(name)) = (block["id"].as_str(), block["name"].as_str()) else {
            return;
        };
        let input = &block["input"];
        let path = input["file_path"]
            .as_str()
            .or_else(|| input["path"].as_str())
            .unwrap_or_default();
        let (action, target) = match name {
            "Read" => ("read", self.path_label(path)),
            "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => ("write", self.path_label(path)),
            "Grep" | "Glob" | "WebSearch" | "WebFetch" => ("search", self.path_label(path)),
            "Bash" | "PowerShell" => ("command", String::new()),
            name if name.starts_with("mcp__") => ("mcp", self.label(name)),
            name => ("tool", self.label(name)),
        };
        events.push(AgentEvent::Tool {
            id: id.to_owned(),
            action,
            target,
            state: "running",
        });
    }

    fn path_label(&self, raw: &str) -> String {
        let path = Path::new(raw);
        let local = self.workspace.and_then(|root| path.strip_prefix(root).ok());
        let label = local
            .and_then(Path::to_str)
            .or_else(|| path.file_name()?.to_str())
            .unwrap_or_default();
        self.label(label)
    }

    fn label(&self, value: &str) -> String {
        value
            .chars()
            .filter(|c| !c.is_control())
            .take(160)
            .collect()
    }
}
