use std::{env, net::Ipv4Addr, process::Command, slice};
use url::Url;
use windows_sys::Win32::{
    Foundation::GlobalFree,
    Networking::WinHttp::{
        WinHttpGetIEProxyConfigForCurrentUser, WINHTTP_CURRENT_USER_IE_PROXY_CONFIG,
    },
};

pub fn inherit_system_proxy(command: &mut Command) {
    // Windows environment variable names are case-insensitive. Keep explicit CLI proxy settings.
    if ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]
        .iter()
        .any(|name| env::var_os(name).is_some_and(|value| !value.is_empty()))
    {
        return;
    }

    let mut config = WINHTTP_CURRENT_USER_IE_PROXY_CONFIG::default();
    let loaded = unsafe { WinHttpGetIEProxyConfigForCurrentUser(&mut config) } != 0;
    let servers = take_wide_string(config.lpszProxy);
    let exclusions = take_wide_string(config.lpszProxyBypass);
    let auto_config = take_wide_string(config.lpszAutoConfigUrl);
    if !loaded || auto_config.is_some_and(|url| !url.is_empty()) {
        return;
    }
    let Some(servers) = servers else { return };
    let (http, https) = proxy_servers(&servers);
    if http.is_none() && https.is_none() {
        return;
    }
    if let Some(http) = http {
        command.env("HTTP_PROXY", http);
    }
    if let Some(https) = https {
        command.env("HTTPS_PROXY", https);
    }
    if env::var_os("NO_PROXY").is_none() {
        command.env(
            "NO_PROXY",
            no_proxy(exclusions.as_deref().unwrap_or_default()),
        );
    }
}

fn take_wide_string(text: *mut u16) -> Option<String> {
    if text.is_null() {
        return None;
    }
    // WinHTTP returns null-terminated strings allocated with GlobalAlloc.
    unsafe {
        let len = (0..).find(|&index| *text.add(index) == 0).unwrap();
        let value = String::from_utf16_lossy(slice::from_raw_parts(text, len));
        GlobalFree(text.cast());
        Some(value)
    }
}

fn proxy_servers(setting: &str) -> (Option<String>, Option<String>) {
    let (mut shared, mut http, mut https) = (None, None, None);
    for entry in setting.split(|ch: char| ch == ';' || ch.is_ascii_whitespace()) {
        if let Some((protocol, server)) = entry.split_once('=') {
            match protocol.to_ascii_lowercase().as_str() {
                "http" => http = proxy_url(server),
                "https" => https = proxy_url(server),
                _ => {}
            }
        } else if !entry.is_empty() {
            shared = proxy_url(entry);
        }
    }
    (http.or_else(|| shared.clone()), https.or(shared))
}

fn proxy_url(server: &str) -> Option<String> {
    let url = if server.contains("://") {
        Url::parse(server)
    } else {
        Url::parse(&format!("http://{server}"))
    }
    .ok()?;
    (url.has_host() && matches!(url.scheme(), "http" | "https" | "socks5" | "socks5h"))
        .then(|| url.into())
}

fn no_proxy(exclusions: &str) -> String {
    let mut domains = vec!["localhost".into(), "127.0.0.1".into(), "::1".into()];
    domains.extend(
        exclusions
            .split(';')
            .map(str::trim)
            .filter(|entry| !entry.is_empty() && !entry.eq_ignore_ascii_case("<local>"))
            .map(|entry| {
                ipv4_range(entry).unwrap_or_else(|| {
                    entry
                        .strip_prefix('*')
                        .filter(|rest| rest.starts_with('.'))
                        .unwrap_or(entry)
                        .to_owned()
                })
            }),
    );
    domains.join(",")
}

fn ipv4_range(entry: &str) -> Option<String> {
    let mut octets = [0; 4];
    let mut prefix_len = 0;
    for value in entry.strip_suffix(".*")?.split('.') {
        *octets.get_mut(prefix_len)? = value.parse::<u8>().ok()?;
        prefix_len += 1;
    }
    (prefix_len < 4).then(|| format!("{}/{}", Ipv4Addr::from(octets), prefix_len * 8))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_shared_and_per_scheme_windows_proxies() {
        assert_eq!(
            proxy_servers("127.0.0.1:1080"),
            (
                Some("http://127.0.0.1:1080/".into()),
                Some("http://127.0.0.1:1080/".into())
            )
        );
        assert_eq!(
            proxy_servers("http=proxy.local:8080;HTTPS=https://secure.local:8181"),
            (
                Some("http://proxy.local:8080/".into()),
                Some("https://secure.local:8181/".into())
            )
        );
        assert_eq!(
            proxy_servers("http=proxy.local:8080"),
            (Some("http://proxy.local:8080/".into()), None)
        );
        assert_eq!(proxy_servers("ftp=proxy.local:8080;https="), (None, None));
    }

    #[test]
    fn converts_windows_proxy_exclusions() {
        assert_eq!(
            no_proxy("<local>;10.*;172.16.*;192.168.1.*;*.intranet.example;192.168.20.1"),
            "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/16,192.168.1.0/24,.intranet.example,192.168.20.1"
        );
    }
}
