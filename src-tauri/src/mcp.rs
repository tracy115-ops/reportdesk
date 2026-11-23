use reqwest::{Client, Method, Response, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{State, WebviewWindow};

const MAX_CONFIG: usize = 256 * 1024;
const MAX_REQUEST: usize = 128 * 1024;
const MAX_RESPONSE: usize = 1024 * 1024;
const MAX_SERVERS: usize = 32;
const MAX_TOOLS: usize = 128;
const RPC_TIMEOUT: Duration = Duration::from_secs(45);
const PROTOCOL: &str = "2025-06-18";
type Result<T> = std::result::Result<T, &'static str>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    id: String,
    name: String,
    #[serde(flatten)]
    connection: Connection,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Connection {
    Http { url: String },
    Stdio { command: String, args: Vec<String> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    name: String,
    description: String,
    input_schema: Value,
}

pub struct McpRegistry {
    path: PathBuf,
    writing: Mutex<()>,
    active: AtomicBool,
    client: Client,
}

impl McpRegistry {
    pub fn new(path: PathBuf) -> std::result::Result<Self, reqwest::Error> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            path,
            writing: Mutex::new(()),
            active: AtomicBool::new(false),
            client,
        })
    }

    fn load(&self) -> Result<Vec<McpServer>> {
        let file = match fs::File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => return Err("mcp_storage"),
        };
        let mut bytes = Vec::new();
        file.take(MAX_CONFIG as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "mcp_storage")?;
        if bytes.len() > MAX_CONFIG {
            return Err("mcp_storage");
        }
        serde_json::from_slice(&bytes).map_err(|_| "mcp_storage")
    }

    fn persist(&self, servers: &[McpServer]) -> Result<()> {
        let folder = self.path.parent().ok_or("mcp_storage")?;
        fs::create_dir_all(folder).map_err(|_| "mcp_storage")?;
        let mut output = tempfile::NamedTempFile::new_in(folder).map_err(|_| "mcp_storage")?;
        let bytes = serde_json::to_vec(servers).map_err(|_| "mcp_storage")?;
        if bytes.len() > MAX_CONFIG {
            return Err("mcp_limit");
        }
        output.write_all(&bytes).map_err(|_| "mcp_storage")?;
        output.as_file().sync_all().map_err(|_| "mcp_storage")?;
        output.persist(&self.path).map_err(|_| "mcp_storage")?;
        Ok(())
    }

    fn configured(&self, id: &str) -> Result<McpServer> {
        self.load()?
            .into_iter()
            .find(|server| server.id == id)
            .ok_or("mcp_missing")
    }

    fn acquire(&self) -> Result<SessionPermit<'_>> {
        if self.active.swap(true, Ordering::Acquire) {
            return Err("mcp_busy");
        }
        Ok(SessionPermit(&self.active))
    }
}

struct SessionPermit<'a>(&'a AtomicBool);
impl Drop for SessionPermit<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn main_window(window: &WebviewWindow) -> Result<()> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("mcp_window")
    }
}

fn endpoint(value: &str) -> Result<Url> {
    let parsed = Url::parse(value).map_err(|_| "mcp_config")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err("mcp_config");
    }
    Ok(parsed)
}

fn executable(command: &str) -> Result<PathBuf> {
    let path = Path::new(command);
    if !path.is_absolute() || !path.is_file() {
        return Err("mcp_executable");
    }
    #[cfg(windows)]
    if !path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
    {
        return Err("mcp_executable");
    }
    path.canonicalize().map_err(|_| "mcp_executable")
}

fn validate(mut server: McpServer) -> Result<McpServer> {
    server.name = server.name.trim().chars().take(100).collect();
    if server.name.is_empty() {
        return Err("mcp_config");
    }
    if !server.id.is_empty() && uuid::Uuid::parse_str(&server.id).is_err() {
        return Err("mcp_config");
    }
    match &mut server.connection {
        Connection::Http { url } => {
            if url.len() > 2048 {
                return Err("mcp_config");
            }
            *url = endpoint(url.trim())?.to_string();
        }
        Connection::Stdio { command, args } => {
            if command.len() > 2048
                || args.len() > 64
                || args
                    .iter()
                    .any(|arg| arg.len() > 2048 || arg.contains('\0'))
            {
                return Err("mcp_config");
            }
            *command = executable(command.trim())?
                .to_str()
                .ok_or("mcp_executable")?
                .to_owned();
        }
    }
    Ok(server)
}

#[tauri::command]
pub fn mcp_servers(
    window: WebviewWindow,
    registry: State<'_, McpRegistry>,
) -> Result<Vec<McpServer>> {
    main_window(&window)?;
    registry.load()
}

#[tauri::command]
pub fn mcp_save(
    window: WebviewWindow,
    registry: State<'_, McpRegistry>,
    server: McpServer,
) -> Result<McpServer> {
    main_window(&window)?;
    let mut server = validate(server)?;
    let _guard = registry.writing.lock().map_err(|_| "mcp_storage")?;
    let mut all = registry.load()?;
    if server.id.is_empty() {
        if all.len() >= MAX_SERVERS {
            return Err("mcp_limit");
        }
        server.id = uuid::Uuid::new_v4().to_string();
        all.push(server.clone());
    } else {
        let existing = all
            .iter_mut()
            .find(|item| item.id == server.id)
            .ok_or("mcp_missing")?;
        *existing = server.clone();
    }
    registry.persist(&all)?;
    Ok(server)
}

#[tauri::command]
pub fn mcp_remove(
    window: WebviewWindow,
    registry: State<'_, McpRegistry>,
    id: String,
) -> Result<()> {
    main_window(&window)?;
    let _guard = registry.writing.lock().map_err(|_| "mcp_storage")?;
    let mut all = registry.load()?;
    all.retain(|server| server.id != id);
    registry.persist(&all)
}

fn rpc_message(id: Option<u32>, method: &str, params: Value) -> Value {
    let mut data = json!({"jsonrpc":"2.0", "method":method});
    if let Some(id) = id {
        data["id"] = json!(id);
    }
    if !params.is_null() {
        data["params"] = params;
    }
    data
}

fn initialization() -> Value {
    rpc_message(
        Some(1),
        "initialize",
        json!({
            "protocolVersion":PROTOCOL, "capabilities":{},
            "clientInfo":{"name":"Office Workspace", "version":env!("CARGO_PKG_VERSION")}
        }),
    )
}

fn protocol(result: &Value) -> Result<&str> {
    result["protocolVersion"]
        .as_str()
        .filter(|version| {
            matches!(
                *version,
                "2024-11-05" | "2025-03-26" | "2025-06-18" | "2025-11-25"
            )
        })
        .ok_or("mcp_protocol")
}

fn rpc_result(bytes: &[u8], id: u32) -> Result<Option<Value>> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "mcp_protocol")?;
    if value["id"].as_u64() != Some(u64::from(id)) {
        return Ok(None);
    }
    if value.get("error").is_some() {
        return Err("mcp_remote");
    }
    value.get("result").cloned().map(Some).ok_or("mcp_protocol")
}

fn remaining(deadline: Instant) -> Result<Duration> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        Err("mcp_timeout")
    } else {
        Ok(remaining)
    }
}

fn network_error(error: reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "mcp_timeout"
    } else {
        "mcp_connection"
    }
}

async fn http_result(mut response: Response, id: u32) -> Result<Value> {
    let is_sse = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/event-stream"));
    let mut body = Vec::new();
    let mut event = Vec::new();
    let mut total = 0;
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        total += chunk.len();
        if total > MAX_RESPONSE {
            return Err("mcp_limit");
        }
        body.extend_from_slice(&chunk);
        if !is_sse {
            continue;
        }
        let mut consumed = 0;
        while let Some(end) = body[consumed..].iter().position(|&byte| byte == b'\n') {
            let line = &body[consumed..consumed + end];
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            consumed += end + 1;
            if let Some(data) = line.strip_prefix(b"data:") {
                if !event.is_empty() {
                    event.push(b'\n');
                }
                event.extend_from_slice(data.strip_prefix(b" ").unwrap_or(data));
            } else if line.is_empty() && !event.is_empty() {
                if let Some(value) = rpc_result(&event, id)? {
                    return Ok(value);
                }
                event.clear();
            }
        }
        body.drain(..consumed);
    }
    let payload = if is_sse { &event } else { &body };
    rpc_result(payload, id)?.ok_or("mcp_protocol")
}

struct HttpSession {
    client: Client,
    url: Url,
    session: Option<reqwest::header::HeaderValue>,
    version: Option<String>,
    deadline: Instant,
}

impl HttpSession {
    fn request(&self, method: Method) -> Result<reqwest::RequestBuilder> {
        let mut request = self
            .client
            .request(method, self.url.clone())
            .timeout(remaining(self.deadline)?)
            .header("Accept", "application/json, text/event-stream");
        if let Some(value) = &self.session {
            request = request.header("Mcp-Session-Id", value.clone());
        }
        if let Some(version) = &self.version {
            request = request.header("MCP-Protocol-Version", version);
        }
        Ok(request)
    }

    async fn post(&self, message: &Value) -> Result<Response> {
        self.request(Method::POST)?
            .json(message)
            .send()
            .await
            .map_err(network_error)?
            .error_for_status()
            .map_err(network_error)
    }

    async fn initialize(&mut self) -> Result<()> {
        let response = self.post(&initialization()).await?;
        self.session = response.headers().get("Mcp-Session-Id").cloned();
        self.version = Some(protocol(&http_result(response, 1).await?)?.to_owned());
        self.post(&rpc_message(None, "notifications/initialized", Value::Null))
            .await?;
        Ok(())
    }

    async fn rpc(&self, id: u32, method: &str, params: Value) -> Result<Value> {
        let response = self.post(&rpc_message(Some(id), method, params)).await?;
        http_result(response, id).await
    }

    async fn close(&self) {
        if self.session.is_some() {
            if let Ok(request) = self.request(Method::DELETE) {
                let _ = request.timeout(Duration::from_secs(2)).send().await;
            }
        }
    }
}

struct StdioSession {
    child: Child,
    writer: mpsc::SyncSender<StdioWrite>,
    lines: mpsc::Receiver<Result<Vec<u8>>>,
    deadline: Instant,
    _directory: tempfile::TempDir,
}

struct StdioWrite {
    line: Vec<u8>,
    complete: mpsc::SyncSender<bool>,
}

impl StdioSession {
    fn open(path: PathBuf, args: Vec<String>, deadline: Instant) -> Result<Self> {
        let directory = tempfile::tempdir().map_err(|_| "mcp_connection")?;
        let mut command = Command::new(path);
        command
            .args(args)
            .current_dir(directory.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env_clear();
        for key in [
            "PATH",
            "SYSTEMROOT",
            "WINDIR",
            "TEMP",
            "TMP",
            "TMPDIR",
            "LANG",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|_| "mcp_connection")?;
        let mut stdin = child.stdin.take().ok_or("mcp_connection")?;
        let stdout = child.stdout.take().ok_or("mcp_connection")?;
        let (writer, writes) = mpsc::sync_channel::<StdioWrite>(1);
        std::thread::spawn(move || {
            while let Ok(write) = writes.recv() {
                let written = stdin.write_all(&write.line).is_ok();
                let _ = write.complete.send(written);
                if !written {
                    break;
                }
            }
        });
        let (sender, lines) = mpsc::sync_channel(8);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                match reader
                    .by_ref()
                    .take(MAX_RESPONSE as u64 + 1)
                    .read_until(b'\n', &mut line)
                {
                    Ok(0) => break,
                    Ok(_) if line.len() > MAX_RESPONSE => {
                        let _ = sender.send(Err("mcp_limit"));
                        break;
                    }
                    Ok(_) => {
                        if sender.send(Ok(line)).is_err() {
                            break;
                        }
                    }
                    Err(_) => {
                        let _ = sender.send(Err("mcp_connection"));
                        break;
                    }
                }
            }
        });
        Ok(Self {
            child,
            writer,
            lines,
            deadline,
            _directory: directory,
        })
    }

    fn send(&self, message: &Value) -> Result<()> {
        let mut line = serde_json::to_vec(message).map_err(|_| "mcp_protocol")?;
        line.push(b'\n');
        let (complete, result) = mpsc::sync_channel(1);
        self.writer
            .try_send(StdioWrite { line, complete })
            .map_err(|_| "mcp_connection")?;
        let success = result
            .recv_timeout(remaining(self.deadline)?)
            .map_err(stdio_wait_error)?;
        if success {
            Ok(())
        } else {
            Err("mcp_connection")
        }
    }

    fn response(&self, id: u32) -> Result<Value> {
        loop {
            let line = self
                .lines
                .recv_timeout(remaining(self.deadline)?)
                .map_err(stdio_wait_error)??;
            if let Some(result) = rpc_result(&line, id)? {
                return Ok(result);
            }
        }
    }

    fn initialize(&self) -> Result<()> {
        self.send(&initialization())?;
        protocol(&self.response(1)?)?;
        self.send(&rpc_message(None, "notifications/initialized", Value::Null))
    }
}

fn stdio_wait_error(error: mpsc::RecvTimeoutError) -> &'static str {
    match error {
        mpsc::RecvTimeoutError::Timeout => "mcp_timeout",
        mpsc::RecvTimeoutError::Disconnected => "mcp_connection",
    }
}

impl Drop for StdioSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

enum Operation {
    Tools,
    Call { tool: String, args: Value },
}

fn collect_tools(page: Value, tools: &mut Vec<Value>) -> Result<Option<Value>> {
    let rows = page["tools"].as_array().ok_or("mcp_protocol")?;
    tools.extend(
        rows.iter()
            .take(MAX_TOOLS.saturating_sub(tools.len()))
            .cloned(),
    );
    if tools.len() >= MAX_TOOLS {
        return Ok(None);
    }
    Ok(page["nextCursor"]
        .as_str()
        .filter(|cursor| !cursor.is_empty() && cursor.len() <= 2048)
        .map(|cursor| json!({"cursor":cursor})))
}

async fn execute(registry: &McpRegistry, server: McpServer, operation: Operation) -> Result<Value> {
    let _permit = registry.acquire()?;
    let deadline = Instant::now() + RPC_TIMEOUT;
    let (method, mut params) = match operation {
        Operation::Tools => ("tools/list", json!({})),
        Operation::Call { tool, args } => ("tools/call", json!({"name":tool, "arguments":args})),
    };
    match server.connection {
        Connection::Http { url } => {
            let mut session = HttpSession {
                client: registry.client.clone(),
                url: endpoint(&url)?,
                session: None,
                version: None,
                deadline,
            };
            let result = async {
                session.initialize().await?;
                if method != "tools/list" {
                    return session.rpc(2, method, params).await;
                }
                let mut tools = Vec::new();
                for id in 2..6 {
                    let page = session.rpc(id, method, params).await?;
                    let Some(next) = collect_tools(page, &mut tools)? else {
                        break;
                    };
                    params = next;
                }
                Ok(json!({"tools":tools}))
            }
            .await;
            session.close().await;
            result
        }
        Connection::Stdio { command, args } => tauri::async_runtime::spawn_blocking(move || {
            let session = StdioSession::open(executable(&command)?, args, deadline)?;
            session.initialize()?;
            if method != "tools/list" {
                session.send(&rpc_message(Some(2), method, params))?;
                return session.response(2);
            }
            let mut tools = Vec::new();
            for id in 2..6 {
                session.send(&rpc_message(Some(id), method, params))?;
                let Some(next) = collect_tools(session.response(id)?, &mut tools)? else {
                    break;
                };
                params = next;
            }
            Ok(json!({"tools":tools}))
        })
        .await
        .map_err(|_| "mcp_connection")?,
    }
}

fn tool_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

#[tauri::command]
pub async fn mcp_tools(
    window: WebviewWindow,
    registry: State<'_, McpRegistry>,
    id: String,
) -> Result<Vec<McpTool>> {
    main_window(&window)?;
    let server = registry.configured(&id)?;
    let result = execute(&registry, server, Operation::Tools).await?;
    let tools = result["tools"].as_array().ok_or("mcp_protocol")?;
    Ok(tools
        .iter()
        .take(MAX_TOOLS)
        .filter_map(|tool| {
            let name = tool["name"]
                .as_str()
                .filter(|name| tool_name(name))?
                .to_owned();
            let description = tool["description"]
                .as_str()
                .unwrap_or_default()
                .chars()
                .take(1200)
                .collect();
            let schema = &tool["inputSchema"];
            let input_schema = if schema.is_object() {
                schema.clone()
            } else {
                json!({"type":"object"})
            };
            Some(McpTool {
                name,
                description,
                input_schema,
            })
        })
        .collect())
}

#[tauri::command]
pub async fn mcp_call(
    window: WebviewWindow,
    registry: State<'_, McpRegistry>,
    id: String,
    tool: String,
    args: Value,
) -> Result<Value> {
    main_window(&window)?;
    if !tool_name(&tool) || !args.is_object() {
        return Err("mcp_arguments");
    }
    if serde_json::to_vec(&args)
        .map_err(|_| "mcp_arguments")?
        .len()
        > MAX_REQUEST
    {
        return Err("mcp_limit");
    }
    let server = registry.configured(&id)?;
    execute(&registry, server, Operation::Call { tool, args }).await
}
