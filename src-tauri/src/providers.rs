use crate::agent_activity::AgentEvent;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::future::{AbortHandle, Abortable};
use reqwest::{header, multipart, Client, Method, Response, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet, fs, io::Write, net::IpAddr, path::PathBuf, sync::Mutex, time::Duration,
};
use tauri::{
    ipc::{Channel, JavaScriptChannelId},
    State, Webview,
};
use url::Host;
use zeroize::Zeroizing;

const JSON_LIMIT: usize = 4 * 1024 * 1024;
const MEDIA_LIMIT: usize = 22 * 1024 * 1024;
const PROFILE_LIMIT: usize = 1024 * 1024;
const TEXT_LIMIT: usize = 80_000;
type ProviderResult<T> = Result<T, &'static str>;

#[derive(Clone, Copy, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ProviderKind {
    Openai,
    Anthropic,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfile {
    id: String,
    name: String,
    kind: ProviderKind,
    base_url: String,
    text_model: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    text_models: Vec<String>,
    embedding_model: Option<String>,
    image_model: Option<String>,
    tts_model: Option<String>,
    video_model: Option<String>,
}

impl ProviderProfile {
    fn restore_text_model(&mut self) {
        if self.text_models.is_empty() {
            self.text_models.extend(self.text_model.clone());
        }
        if !self
            .text_model
            .as_ref()
            .is_some_and(|id| self.text_models.contains(id))
        {
            self.text_model = self.text_models.first().cloned();
        }
    }

    fn selected_model(&self, id: Option<&str>) -> ProviderResult<&str> {
        match id {
            Some(id) => self
                .text_models
                .iter()
                .find(|item| item.as_str() == id)
                .map(String::as_str)
                .ok_or("provider_model"),
            None => model(&self.text_model),
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredProvider {
    #[serde(flatten)]
    profile: ProviderProfile,
    #[serde(skip_serializing_if = "Option::is_none")]
    protected_key: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicProvider {
    #[serde(flatten)]
    profile: ProviderProfile,
    has_key: bool,
}

impl StoredProvider {
    fn public(&self) -> PublicProvider {
        PublicProvider {
            profile: self.profile.clone(),
            has_key: self.protected_key.is_some(),
        }
    }
}

pub struct Providers {
    path: PathBuf,
    writing: Mutex<()>,
    active_text: Mutex<Option<AbortHandle>>,
    client: Client,
}

struct TextJob<'a>(&'a Mutex<Option<AbortHandle>>);

impl Drop for TextJob<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.lock() {
            *active = None;
        }
    }
}

impl Providers {
    pub fn new(path: PathBuf) -> Result<Self, reqwest::Error> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(45))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            path,
            writing: Mutex::new(()),
            active_text: Mutex::new(None),
            client,
        })
    }

    fn read(&self) -> ProviderResult<Vec<StoredProvider>> {
        match fs::read(&self.path) {
            Ok(bytes) if bytes.len() <= PROFILE_LIMIT => {
                let mut entries: Vec<StoredProvider> =
                    serde_json::from_slice(&bytes).map_err(|_| "provider_storage")?;
                for entry in &mut entries {
                    entry.profile.restore_text_model();
                }
                Ok(entries)
            }
            Ok(_) => Err("provider_storage"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(_) => Err("provider_storage"),
        }
    }

    fn write(&self, providers: &[StoredProvider]) -> ProviderResult<()> {
        let parent = self.path.parent().ok_or("provider_storage")?;
        let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|_| "provider_storage")?;
        let bytes = serde_json::to_vec(providers).map_err(|_| "provider_storage")?;
        if bytes.len() > PROFILE_LIMIT {
            return Err("provider_storage");
        }
        staged.write_all(&bytes).map_err(|_| "provider_storage")?;
        staged.flush().map_err(|_| "provider_storage")?;
        staged
            .as_file()
            .sync_all()
            .map_err(|_| "provider_storage")?;
        staged.persist(&self.path).map_err(|_| "provider_storage")?;
        Ok(())
    }

    fn get(&self, id: &str) -> ProviderResult<StoredProvider> {
        self.read()?
            .into_iter()
            .find(|entry| entry.profile.id == id)
            .ok_or("provider_missing")
    }

    fn request(
        &self,
        entry: &StoredProvider,
        method: Method,
        route: &str,
    ) -> ProviderResult<reqwest::RequestBuilder> {
        let key = entry.protected_key.as_deref().map(reveal).transpose()?;
        self.request_with_key(
            entry.profile.kind,
            key.as_ref().map(|key| key.as_str()),
            method,
            endpoint(&entry.profile.base_url, route)?,
        )
    }

    fn request_with_key(
        &self,
        kind: ProviderKind,
        key: Option<&str>,
        method: Method,
        url: Url,
    ) -> ProviderResult<reqwest::RequestBuilder> {
        let mut request = self.client.request(method, url);
        if kind == ProviderKind::Anthropic {
            request = request.header("anthropic-version", "2023-06-01");
        }
        if let Some(key) = key {
            let key = checked_key(key)?;
            let (name, value) = match kind {
                ProviderKind::Openai => (
                    header::AUTHORIZATION,
                    header::HeaderValue::from_str(&Zeroizing::new(format!("Bearer {key}"))),
                ),
                ProviderKind::Anthropic => (
                    header::HeaderName::from_static("x-api-key"),
                    header::HeaderValue::from_str(key),
                ),
            };
            let mut value = value.map_err(|_| "provider_key_store")?;
            value.set_sensitive(true);
            request = request.header(name, value);
        }
        Ok(request)
    }

    async fn text(&self, task: TextRequest<'_>) -> ProviderResult<TextReply> {
        let (abort, registration) = AbortHandle::new_pair();
        {
            let mut active = self.active_text.lock().map_err(|_| "provider_storage")?;
            if active.is_some() {
                return Err("provider_busy");
            }
            *active = Some(abort);
        }
        let _job = TextJob(&self.active_text);
        Abortable::new(self.generate_text(task), registration)
            .await
            .map_err(|_| "provider_cancelled")?
    }

    async fn generate_text(&self, task: TextRequest<'_>) -> ProviderResult<TextReply> {
        let TextRequest {
            id,
            model_id,
            system,
            prompt,
            schema,
            progress,
        } = task;
        validate_text(prompt, TEXT_LIMIT)?;
        if system.len() > 20_000 {
            return Err("provider_input");
        }
        let entry = self.get(id)?;
        let model = entry.profile.selected_model(model_id)?;
        let system = match &schema {
            Some(value) if value.is_object() => {
                let schema = serde_json::to_string(value).map_err(|_| "provider_input")?;
                if schema.len() > 24_000 {
                    return Err("provider_input");
                }
                format!("{system}\n\nReturn a JSON object only. It must conform to this JSON schema:\n{schema}")
            }
            Some(_) => return Err("provider_input"),
            None => system.to_owned(),
        };
        let (route, body) = match entry.profile.kind {
            ProviderKind::Openai => (
                "chat/completions",
                json!({
                    "model":model,
                    "messages":[{"role":"system","content":system},{"role":"user","content":prompt}],
                }),
            ),
            ProviderKind::Anthropic => (
                "messages",
                json!({
                    "model":model,"max_tokens":4096,"system":system,
                    "messages":[{"role":"user","content":prompt}],
                }),
            ),
        };
        let text = if let Some(channel) = progress.filter(|_| schema.is_none()) {
            self.chat_text(&entry, route, body, channel).await?
        } else {
            let answer = read_json(
                self.request(&entry, Method::POST, route)?.json(&body),
                JSON_LIMIT,
            )
            .await?;
            response_text(&answer, entry.profile.kind)?
        };
        if text.trim().is_empty() || text.len() > TEXT_LIMIT {
            return Err("provider_output");
        }
        let structured = schema.is_some().then(|| parse_object(&text)).transpose()?;
        Ok(TextReply { text, structured })
    }

    async fn chat_text(
        &self,
        entry: &StoredProvider,
        route: &str,
        mut body: Value,
        channel: &Channel<Vec<AgentEvent>>,
    ) -> ProviderResult<String> {
        body["stream"] = Value::Bool(true);
        let request = self.request(entry, Method::POST, route)?;
        let response = request.json(&body).send().await.map_err(network_error)?;
        let kind = entry.profile.kind;
        // Retry only an explicit rejection of the streaming parameter before any response is generated.
        if matches!(response.status().as_u16(), 400 | 422 | 501) {
            let bytes = read_body(response, 64 * 1024, "provider_request").await?;
            if streaming_rejected(&bytes) {
                body["stream"] = Value::Bool(false);
                let answer = read_json(
                    self.request(entry, Method::POST, route)?.json(&body),
                    JSON_LIMIT,
                )
                .await?;
                return response_text(&answer, kind);
            }
            return Err("provider_request");
        }
        let response = status(response)?;
        if response_media_type(&response).eq_ignore_ascii_case("text/event-stream") {
            stream_text(response, kind, channel).await
        } else {
            let bytes = read_body(response, JSON_LIMIT, "provider_output").await?;
            let answer: Value = serde_json::from_slice(&bytes).map_err(|_| "provider_output")?;
            response_text(&answer, kind)
        }
    }
}

fn response_text(answer: &Value, kind: ProviderKind) -> ProviderResult<String> {
    match kind {
        ProviderKind::Openai => answer
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or("provider_output"),
        ProviderKind::Anthropic => Ok(answer["content"]
            .as_array()
            .ok_or("provider_output")?
            .iter()
            .filter(|part| part["type"] == "text")
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n")),
    }
}

fn streaming_rejected(bytes: &[u8]) -> bool {
    let body = String::from_utf8_lossy(bytes).to_ascii_lowercase();
    body.contains("stream")
        && [
            "not support",
            "unsupported",
            "not implement",
            "not permitted",
            "unknown field",
            "unrecognized",
            "extra_forbidden",
        ]
        .iter()
        .any(|phrase| body.contains(phrase))
}

fn validate_text(value: &str, max: usize) -> ProviderResult<()> {
    if value.trim().is_empty() || value.len() > max {
        return Err("provider_input");
    }
    Ok(())
}

fn valid_model_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 180 && !id.chars().any(char::is_control)
}

fn checked_key(key: &str) -> ProviderResult<&str> {
    if key.len() > 4096 || key.trim().chars().any(char::is_control) {
        return Err("provider_input");
    }
    Ok(key.trim())
}

fn model(value: &Option<String>) -> ProviderResult<&str> {
    value.as_deref().ok_or("provider_model")
}

fn normalize_base(value: &str) -> ProviderResult<Url> {
    if value.len() > 2048 {
        return Err("provider_url");
    }
    let url = Url::parse(value.trim()).map_err(|_| "provider_url")?;
    let supported = match (url.scheme(), url.host()) {
        ("https", Some(_)) => true,
        ("http", Some(Host::Ipv4(_) | Host::Ipv6(_) | Host::Domain("localhost"))) => true,
        _ => false,
    };
    if !supported
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("provider_url");
    }
    Ok(url)
}

fn endpoint(base: &str, route: &str) -> ProviderResult<Url> {
    let mut url = normalize_base(base)?;
    url.path_segments_mut()
        .map_err(|_| "provider_url")?
        .pop_if_empty()
        .extend(route.split('/'));
    Ok(url)
}

fn canonical_base(value: &str) -> ProviderResult<String> {
    Ok(normalize_base(value)?
        .to_string()
        .trim_end_matches('/')
        .to_owned())
}

#[tauri::command]
pub fn provider_list(state: State<'_, Providers>) -> ProviderResult<Vec<PublicProvider>> {
    Ok(state.read()?.iter().map(StoredProvider::public).collect())
}

#[tauri::command]
pub fn provider_save(
    state: State<'_, Providers>,
    mut profile: ProviderProfile,
    api_key: Option<String>,
) -> ProviderResult<PublicProvider> {
    uuid::Uuid::parse_str(&profile.id).map_err(|_| "provider_input")?;
    profile.name = profile.name.trim().to_owned();
    validate_text(&profile.name, 100)?;
    profile.base_url = canonical_base(&profile.base_url)?;
    for field in [
        &mut profile.text_model,
        &mut profile.embedding_model,
        &mut profile.image_model,
        &mut profile.tts_model,
        &mut profile.video_model,
    ] {
        if let Some(value) = field.take() {
            let trimmed = value.trim();
            if trimmed.len() > 180 || trimmed.chars().any(char::is_control) {
                return Err("provider_input");
            }
            if !trimmed.is_empty() {
                *field = Some(trimmed.to_owned());
            }
        }
    }
    let mut unique = BTreeSet::new();
    let mut text_models = Vec::new();
    for id in std::mem::take(&mut profile.text_models) {
        let id = id.trim();
        if !valid_model_id(id) {
            return Err("provider_input");
        }
        if unique.insert(id.to_owned()) {
            text_models.push(id.to_owned());
        }
    }
    profile.text_models = text_models;
    profile.restore_text_model();
    if profile.kind == ProviderKind::Anthropic {
        profile.embedding_model = None;
        profile.image_model = None;
        profile.tts_model = None;
        profile.video_model = None;
    }
    let _guard = state.writing.lock().map_err(|_| "provider_storage")?;
    let mut entries = state.read()?;
    let position = entries
        .iter()
        .position(|entry| entry.profile.id == profile.id);
    let protected_key = match api_key.map(Zeroizing::new) {
        Some(key) if key.trim().is_empty() => None,
        Some(key) => Some(protect(checked_key(&key)?)?),
        None => position.and_then(|index| {
            let previous = &entries[index];
            (previous.profile.base_url == profile.base_url && previous.profile.kind == profile.kind)
                .then(|| previous.protected_key.clone())
                .flatten()
        }),
    };
    let entry = StoredProvider {
        profile,
        protected_key,
    };
    let public = entry.public();
    if let Some(index) = position {
        entries[index] = entry;
    } else {
        if entries.len() >= 32 {
            return Err("provider_storage");
        }
        entries.push(entry);
    }
    state.write(&entries)?;
    Ok(public)
}

#[tauri::command]
pub fn provider_remove(state: State<'_, Providers>, id: String) -> ProviderResult<()> {
    let _guard = state.writing.lock().map_err(|_| "provider_storage")?;
    let mut entries = state.read()?;
    entries.retain(|entry| entry.profile.id != id);
    state.write(&entries)
}

#[tauri::command]
pub async fn provider_models(
    state: State<'_, Providers>,
    mut profile: ProviderProfile,
    api_key: Option<String>,
) -> ProviderResult<Vec<String>> {
    profile.base_url = canonical_base(&profile.base_url)?;
    let key = match api_key.map(Zeroizing::new) {
        Some(key) if !key.trim().is_empty() => Some(key),
        _ => state
            .read()?
            .into_iter()
            .find(|entry| {
                entry.profile.id == profile.id
                    && entry.profile.base_url == profile.base_url
                    && entry.profile.kind == profile.kind
            })
            .and_then(|entry| entry.protected_key)
            .as_deref()
            .map(reveal)
            .transpose()?,
    };
    let mut models = BTreeSet::new();
    let mut seen_pages = BTreeSet::new();
    let mut after = None::<String>;
    loop {
        let mut url = endpoint(&profile.base_url, "models")?;
        if let Some(cursor) = &after {
            url.query_pairs_mut().append_pair("after_id", cursor);
        }
        let request = state
            .request_with_key(
                profile.kind,
                key.as_ref().map(|key| key.as_str()),
                Method::GET,
                url,
            )?
            .timeout(Duration::from_secs(15));
        let answer = read_catalog(request.send().await.map_err(network_error)?).await?;
        models.extend(
            answer
                .data
                .iter()
                .filter_map(|entry| entry["id"].as_str())
                .map(str::trim)
                .filter(|id| valid_model_id(id))
                .map(str::to_owned),
        );
        if profile.kind != ProviderKind::Anthropic || answer.has_more != true {
            return Ok(models.into_iter().collect());
        }
        let cursor = answer
            .last_id
            .as_str()
            .filter(|id| valid_model_id(id))
            .ok_or("provider_output")?;
        if seen_pages.len() >= 16 || !seen_pages.insert(cursor.to_owned()) {
            return Err("provider_output");
        }
        after = Some(cursor.to_owned());
    }
}

#[tauri::command]
pub async fn provider_test(
    state: State<'_, Providers>,
    id: String,
    model_id: Option<String>,
) -> ProviderResult<()> {
    let probe = TextRequest {
        id: &id,
        model_id: model_id.as_deref(),
        system: "",
        prompt: "Respond with OK.",
        schema: None,
        progress: None,
    };
    if model_id.is_some() {
        return state.text(probe).await.map(|_| ());
    }
    let entry = state.get(&id)?;
    let response = state
        .request(&entry, Method::GET, "models")?
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(network_error)?;
    match response.status().as_u16() {
        404 | 405 if entry.profile.text_model.is_some() => {
            state.text(probe).await?;
            Ok(())
        }
        _ => read_catalog(response).await.map(|_| ()),
    }
}

#[derive(Serialize)]
pub struct TextReply {
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    structured: Option<Value>,
}

struct TextRequest<'a> {
    id: &'a str,
    model_id: Option<&'a str>,
    system: &'a str,
    prompt: &'a str,
    schema: Option<Value>,
    progress: Option<&'a Channel<Vec<AgentEvent>>>,
}

#[tauri::command]
pub async fn provider_text(
    state: State<'_, Providers>,
    webview: Webview,
    id: String,
    system: String,
    prompt: String,
    schema: Option<Value>,
    model_id: Option<String>,
    progress: Option<JavaScriptChannelId>,
) -> ProviderResult<TextReply> {
    let progress = progress.map(|id| id.channel_on(webview));
    state
        .text(TextRequest {
            id: &id,
            model_id: model_id.as_deref(),
            system: &system,
            prompt: &prompt,
            schema,
            progress: progress.as_ref(),
        })
        .await
}

#[tauri::command]
pub fn provider_cancel_text(state: State<'_, Providers>) -> ProviderResult<()> {
    if let Some(active) = state
        .active_text
        .lock()
        .map_err(|_| "provider_storage")?
        .as_ref()
    {
        active.abort();
    }
    Ok(())
}

fn parse_object(text: &str) -> ProviderResult<Value> {
    let text = text.trim();
    let content = text
        .strip_prefix("```json")
        .or_else(|| text.strip_prefix("```"))
        .and_then(|value| value.trim_end().strip_suffix("```"))
        .unwrap_or(text);
    let result: Value = serde_json::from_str(content).map_err(|_| "provider_output")?;
    if !result.is_object() {
        return Err("provider_output");
    }
    Ok(result)
}

fn openai(state: &Providers, id: &str) -> ProviderResult<StoredProvider> {
    let entry = state.get(id)?;
    if entry.profile.kind != ProviderKind::Openai {
        return Err("provider_unsupported");
    }
    Ok(entry)
}

#[derive(Deserialize)]
struct Embeddings {
    data: Vec<Embedding>,
}
#[derive(Deserialize)]
struct Embedding {
    index: usize,
    embedding: Vec<f32>,
}

#[tauri::command]
pub async fn provider_embeddings(
    state: State<'_, Providers>,
    id: String,
    input: Vec<String>,
) -> ProviderResult<Vec<Vec<f32>>> {
    if input.is_empty()
        || input.len() > 32
        || input.iter().map(String::len).sum::<usize>() > 64_000
        || input.iter().any(|text| validate_text(text, 8000).is_err())
    {
        return Err("provider_input");
    }
    let entry = openai(&state, &id)?;
    let model = model(&entry.profile.embedding_model)?;
    let request = state
        .request(&entry, Method::POST, "embeddings")?
        .timeout(Duration::from_secs(30))
        .json(&json!({"model":model,"input":input}));
    let count = input.len();
    let mut result: Embeddings = serde_json::from_value(read_json(request, JSON_LIMIT).await?)
        .map_err(|_| "provider_output")?;
    if result.data.len() != count {
        return Err("provider_output");
    }
    result.data.sort_unstable_by_key(|item| item.index);
    let size = result.data.first().map_or(0, |item| item.embedding.len());
    if size == 0
        || size > 8192
        || result.data.iter().enumerate().any(|(index, item)| {
            item.index != index
                || item.embedding.len() != size
                || !item.embedding.iter().all(|value| value.is_finite())
        })
    {
        return Err("provider_output");
    }
    Ok(result.data.into_iter().map(|item| item.embedding).collect())
}

#[derive(Serialize)]
pub struct Media {
    mime: &'static str,
    data: String,
}

fn media(bytes: Vec<u8>, mime: &'static str) -> ProviderResult<Media> {
    if bytes.len() > MEDIA_LIMIT {
        return Err("provider_media_limit");
    }
    let matches = match mime {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "audio/mpeg" => {
            (bytes.len() >= 10 && bytes.starts_with(b"ID3"))
                || matches!(bytes.get(..4), Some([0xff, info, format, _])
                    if info & 0xe6 == 0xe2 && info & 0x18 != 0x08 && format & 0xf0 != 0xf0 && format & 0x0c != 0x0c)
        }
        "video/mp4" => bytes.len() >= 12 && bytes.get(4..8) == Some(b"ftyp"),
        _ => false,
    };
    if !matches {
        return Err("provider_output");
    }
    Ok(Media {
        mime,
        data: BASE64.encode(bytes),
    })
}

#[tauri::command]
pub async fn provider_image(
    state: State<'_, Providers>,
    id: String,
    prompt: String,
    size: Option<String>,
) -> ProviderResult<Media> {
    validate_text(&prompt, 12_000)?;
    let entry = openai(&state, &id)?;
    let model = model(&entry.profile.image_model)?;
    let mut body = json!({"model":model,"prompt":prompt,"n":1});
    if let Some(size) = size {
        body["size"] = json!(validate_size(&size)?);
    }
    let request = state
        .request(&entry, Method::POST, "images/generations")?
        .timeout(Duration::from_secs(180))
        .json(&body);
    let answer = read_json(request, 32 * 1024 * 1024).await?;
    if let Some(data) = answer.pointer("/data/0/b64_json").and_then(Value::as_str) {
        return media(
            BASE64.decode(data).map_err(|_| "provider_output")?,
            "image/png",
        );
    }
    let location = answer
        .pointer("/data/0/url")
        .and_then(Value::as_str)
        .ok_or("provider_output")?;
    let url = Url::parse(location).map_err(|_| "provider_output")?;
    let base = normalize_base(&entry.profile.base_url)?;
    if url.origin() != base.origin() && (url.scheme() != "https" || private_literal(&url))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host().is_none()
    {
        return Err("provider_output");
    }
    let bytes = read_bytes(state.client.get(url), MEDIA_LIMIT, "provider_media_limit").await?;
    media(bytes, "image/png")
}

fn private_literal(url: &Url) -> bool {
    let host = url.host_str().unwrap_or_default().trim_matches(['[', ']']);
    if matches!(host, "localhost" | "localhost.") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified()
        }
        Ok(IpAddr::V6(ip)) => {
            ip.is_unique_local()
                || ip.is_loopback()
                || ip.is_unicast_link_local()
                || ip.is_unspecified()
        }
        Err(_) => false,
    }
}

#[tauri::command]
pub async fn provider_speech(
    state: State<'_, Providers>,
    id: String,
    text: String,
    voice: Option<String>,
) -> ProviderResult<Media> {
    validate_text(&text, 12_000)?;
    let voice = voice.as_deref().unwrap_or("alloy");
    validate_text(voice, 80)?;
    let entry = openai(&state, &id)?;
    let model = model(&entry.profile.tts_model)?;
    let request = state
        .request(&entry, Method::POST, "audio/speech")?
        .timeout(Duration::from_secs(90))
        .json(&json!({"model":model,"input":text,"voice":voice,"response_format":"mp3"}));
    media(
        read_bytes(request, MEDIA_LIMIT, "provider_media_limit").await?,
        "audio/mpeg",
    )
}

fn validate_size(value: &str) -> ProviderResult<&str> {
    let (width, height) = value.split_once('x').ok_or("provider_input")?;
    if [width, height].iter().any(|part| {
        part.is_empty() || part.len() > 4 || !part.bytes().all(|byte| byte.is_ascii_digit())
    }) {
        return Err("provider_input");
    }
    Ok(value)
}

fn video_route(id: &str, content: bool) -> ProviderResult<String> {
    if id.is_empty()
        || id.len() > 180
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
    {
        return Err("provider_input");
    }
    let suffix = if content { "/content" } else { "" };
    Ok(format!("videos/{id}{suffix}"))
}

#[derive(Deserialize, Serialize)]
pub struct VideoJob {
    id: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<f32>,
}

async fn video_job(request: reqwest::RequestBuilder) -> ProviderResult<VideoJob> {
    let result: VideoJob = serde_json::from_value(read_json(request, JSON_LIMIT).await?)
        .map_err(|_| "provider_output")?;
    video_route(&result.id, false).map_err(|_| "provider_output")?;
    if ![
        "queued",
        "pending",
        "in_progress",
        "processing",
        "running",
        "completed",
        "succeeded",
        "failed",
        "cancelled",
        "canceled",
    ]
    .contains(&result.status.as_str())
    {
        return Err("provider_output");
    }
    Ok(result)
}

#[tauri::command]
pub async fn provider_video_start(
    state: State<'_, Providers>,
    id: String,
    prompt: String,
    size: Option<String>,
    seconds: Option<u16>,
    reference: Option<VideoReference>,
) -> ProviderResult<VideoJob> {
    validate_text(&prompt, 12_000)?;
    let entry = openai(&state, &id)?;
    let model = model(&entry.profile.video_model)?;
    let mut form = multipart::Form::new()
        .text("model", model.to_owned())
        .text("prompt", prompt);
    if let Some(size) = size {
        validate_size(&size)?;
        form = form.text("size", size);
    }
    if let Some(seconds) = seconds {
        if !(1..=60).contains(&seconds) {
            return Err("provider_input");
        }
        form = form.text("seconds", seconds.to_string());
    }
    if let Some(reference) = reference {
        form = form.part("input_reference", reference.part()?);
    }
    video_job(
        state
            .request(&entry, Method::POST, "videos")?
            .multipart(form),
    )
    .await
}

#[derive(Deserialize)]
pub struct VideoReference {
    mime: String,
    data: String,
}

impl VideoReference {
    fn part(self) -> ProviderResult<multipart::Part> {
        const MAX_REFERENCE: usize = 12 * 1024 * 1024;
        if self.data.len() > (MAX_REFERENCE / 3) * 4 {
            return Err("provider_media_limit");
        }
        let bytes = BASE64.decode(self.data).map_err(|_| "provider_input")?;
        let ext = match self.mime.as_str() {
            "image/png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => "png",
            "image/jpeg" if bytes.starts_with(b"\xff\xd8\xff") => "jpg",
            "image/webp" if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => {
                "webp"
            }
            _ => return Err("provider_input"),
        };
        multipart::Part::bytes(bytes)
            .file_name(format!("reference.{ext}"))
            .mime_str(&self.mime)
            .map_err(|_| "provider_input")
    }
}

#[tauri::command]
pub async fn provider_video_status(
    state: State<'_, Providers>,
    id: String,
    job_id: String,
) -> ProviderResult<VideoJob> {
    let entry = openai(&state, &id)?;
    model(&entry.profile.video_model)?;
    video_job(state.request(&entry, Method::GET, &video_route(&job_id, false)?)?).await
}

#[tauri::command]
pub async fn provider_video_download(
    state: State<'_, Providers>,
    id: String,
    job_id: String,
) -> ProviderResult<Media> {
    let entry = openai(&state, &id)?;
    model(&entry.profile.video_model)?;
    let request = state
        .request(&entry, Method::GET, &video_route(&job_id, true)?)?
        .timeout(Duration::from_secs(90));
    media(
        read_bytes(request, MEDIA_LIMIT, "provider_media_limit").await?,
        "video/mp4",
    )
}

fn network_error(error: reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "provider_timeout"
    } else {
        "provider_network"
    }
}

fn status(response: Response) -> ProviderResult<Response> {
    match response.status().as_u16() {
        200..=299
            if ["text/html", "application/xhtml+xml"]
                .iter()
                .any(|mime| response_media_type(&response).eq_ignore_ascii_case(mime)) =>
        {
            Err("provider_web_page")
        }
        200..=299 => Ok(response),
        401 | 403 => Err("provider_auth"),
        404 => Err("provider_endpoint"),
        429 => Err("provider_rate_limit"),
        500..=599 => Err("provider_service"),
        _ => Err("provider_request"),
    }
}

fn response_media_type(response: &Response) -> &str {
    response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .unwrap_or_default()
}

#[derive(Deserialize)]
struct ModelCatalog {
    data: Vec<Value>,
    #[serde(default)]
    has_more: Value,
    #[serde(default)]
    last_id: Value,
}

async fn read_catalog(response: Response) -> ProviderResult<ModelCatalog> {
    if matches!(response.status().as_u16(), 404 | 405 | 501) {
        return Err("provider_catalog_unavailable");
    }
    let response = status(response)?;
    let bytes = read_body(response, JSON_LIMIT, "provider_catalog_format").await?;
    serde_json::from_slice(&bytes).map_err(|_| "provider_catalog_format")
}

async fn read_json(request: reqwest::RequestBuilder, limit: usize) -> ProviderResult<Value> {
    let bytes = read_bytes(request, limit, "provider_output").await?;
    serde_json::from_slice(&bytes).map_err(|_| "provider_output")
}

async fn read_bytes(
    request: reqwest::RequestBuilder,
    limit: usize,
    limit_error: &'static str,
) -> ProviderResult<Vec<u8>> {
    let response = status(request.send().await.map_err(network_error)?)?;
    read_body(response, limit, limit_error).await
}

async fn read_body(
    mut response: Response,
    limit: usize,
    limit_error: &'static str,
) -> ProviderResult<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|len| len > limit as u64)
    {
        return Err(limit_error);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if bytes.len() + chunk.len() > limit {
            return Err(limit_error);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[derive(Default)]
struct TextStream {
    data: Vec<u8>,
    text: String,
    done: bool,
}

impl TextStream {
    fn line(&mut self, line: &[u8], kind: ProviderKind) -> ProviderResult<()> {
        let line = line.strip_suffix(b"\n").unwrap_or(line);
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        let line = line.strip_prefix(b"\xef\xbb\xbf").unwrap_or(line);
        if line.is_empty() {
            return self.event(kind);
        }
        if let Some(data) = line.strip_prefix(b"data:") {
            if !self.data.is_empty() {
                self.data.push(b'\n');
            }
            self.data
                .extend_from_slice(data.strip_prefix(b" ").unwrap_or(data));
        }
        Ok(())
    }

    fn event(&mut self, kind: ProviderKind) -> ProviderResult<()> {
        if self.data.is_empty() {
            return Ok(());
        }
        let data = std::mem::take(&mut self.data);
        if data == b"[DONE]" {
            self.done = true;
            return Ok(());
        }
        let event: Value = serde_json::from_slice(&data).map_err(|_| "provider_output")?;
        if let Some(error) = event.get("error").filter(|error| !error.is_null()) {
            return Err(
                match error["type"].as_str().or_else(|| error["code"].as_str()) {
                    Some("authentication_error" | "permission_error" | "invalid_api_key") => {
                        "provider_auth"
                    }
                    Some("rate_limit_error" | "rate_limit_exceeded" | "insufficient_quota") => {
                        "provider_rate_limit"
                    }
                    Some("overloaded_error" | "api_error" | "server_error") => "provider_service",
                    _ => "provider_request",
                },
            );
        }
        match kind {
            ProviderKind::Openai => {
                let choice = &event["choices"][0];
                if let Some(text) = choice["delta"]["content"].as_str() {
                    self.text.push_str(text);
                }
                self.done = choice["finish_reason"].is_string();
            }
            ProviderKind::Anthropic => match event["type"].as_str() {
                Some("content_block_start") if event["content_block"]["type"] == "text" => {
                    if !self.text.is_empty() {
                        self.text.push('\n');
                    }
                    self.text
                        .push_str(event["content_block"]["text"].as_str().unwrap_or_default());
                }
                Some("content_block_delta") if event["delta"]["type"] == "text_delta" => {
                    self.text
                        .push_str(event["delta"]["text"].as_str().unwrap_or_default());
                }
                Some("message_stop") => self.done = true,
                Some("message_delta") if event["delta"]["stop_reason"].is_string() => {
                    self.done = true
                }
                _ => {}
            },
        }
        if self.text.len() > TEXT_LIMIT {
            return Err("provider_output");
        }
        Ok(())
    }
}

async fn stream_text(
    mut response: Response,
    kind: ProviderKind,
    channel: &Channel<Vec<AgentEvent>>,
) -> ProviderResult<String> {
    let mut stream = TextStream::default();
    let mut line = Vec::new();
    let mut received = 0;
    while !stream.done {
        let chunk = response.chunk().await.map_err(network_error)?;
        let before = stream.text.len();
        let parsed = if let Some(chunk) = &chunk {
            received += chunk.len();
            if received > JSON_LIMIT {
                return Err("provider_output");
            }
            let mut parsed = Ok(());
            for piece in chunk.split_inclusive(|byte| *byte == b'\n') {
                line.extend_from_slice(piece);
                if piece.ends_with(b"\n") {
                    parsed = stream.line(&line, kind);
                    line.clear();
                    if parsed.is_err() || stream.done {
                        break;
                    }
                }
            }
            parsed
        } else {
            stream.line(&line, kind).and_then(|_| stream.event(kind))
        };
        if stream.text.len() > before {
            let _ = channel.send(vec![AgentEvent::Text {
                text: stream.text[before..].to_owned(),
                replace: false,
            }]);
        }
        parsed?;
        if chunk.is_none() {
            break;
        }
    }
    if !stream.done {
        return Err("provider_stream_interrupted");
    }
    Ok(stream.text)
}

fn protect(key: &str) -> ProviderResult<String> {
    Ok(BASE64.encode(credential_blob(key.as_bytes(), true)?))
}

fn reveal(encrypted: &str) -> ProviderResult<Zeroizing<String>> {
    let encrypted = BASE64.decode(encrypted).map_err(|_| "provider_key_store")?;
    let mut bytes = credential_blob(&encrypted, false)?;
    String::from_utf8(std::mem::take(&mut *bytes))
        .map(Zeroizing::new)
        .map_err(|_| "provider_key_store")
}

#[cfg(windows)]
fn credential_blob(data: &[u8], encrypt: bool) -> ProviderResult<Zeroizing<Vec<u8>>> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let size = u32::try_from(data.len()).map_err(|_| "provider_key_store")?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: size,
        pbData: data.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    let result = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                null(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                null_mut(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if result == 0 || output.pbData.is_null() {
        return Err("provider_key_store");
    }
    let bytes = unsafe {
        let value = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
        let bytes = Zeroizing::new(value.to_vec());
        use zeroize::Zeroize;
        value.zeroize();
        LocalFree(output.pbData.cast());
        bytes
    };
    Ok(bytes)
}

#[cfg(not(windows))]
fn credential_blob(_: &[u8], _: bool) -> ProviderResult<Zeroizing<Vec<u8>>> {
    Err("provider_key_store")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_routes_accept_http_ip_addresses_and_custom_paths() {
        for base in [
            "http://192.168.1.10:8000/v1",
            "http://203.0.113.10:9090/api/v1",
            "http://[2001:db8::10]:8000/v1",
            "http://localhost:8000",
            "https://gateway.example/api/v1",
        ] {
            assert_eq!(
                endpoint(base, "models").unwrap().as_str(),
                format!("{base}/models")
            );
            assert_eq!(
                endpoint(base, "chat/completions").unwrap().as_str(),
                format!("{base}/chat/completions")
            );
        }
    }

    #[test]
    fn provider_addresses_reject_credentials_in_urls_and_non_api_schemes() {
        for base in [
            "http://gateway.example/v1",
            "http://alice@192.168.1.10:8000/v1",
            "http://192.168.1.10:8000/v1?mode=test",
            "http://192.168.1.10:8000/v1#models",
            "file:///model-config.json",
        ] {
            assert_eq!(normalize_base(base), Err("provider_url"));
        }
    }
}
