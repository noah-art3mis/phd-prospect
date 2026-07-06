"""Stable opportunity identity across noisy and syndicated source URLs."""

from __future__ import annotations

import re
from hashlib import sha256
from ipaddress import ip_address
from unicodedata import normalize
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


TRACKING_PARAMETERS = frozenset({"fbclid", "gclid", "mc_cid", "mc_eid"})


class UnsafeSourceUrl(ValueError):
    """A submitted source URL can target a non-public or credentialed endpoint."""


def validate_public_url(url: str) -> None:
    """Reject obvious SSRF targets before a workflow performs an HTTP request."""

    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise UnsafeSourceUrl("source URL must use http or https")
    if parsed.username or parsed.password:
        raise UnsafeSourceUrl("source URL cannot contain credentials")
    try:
        port = parsed.port
    except ValueError as error:
        raise UnsafeSourceUrl("source URL has an invalid port") from error
    if port not in {None, 80, 443}:
        raise UnsafeSourceUrl("source URL cannot use a non-standard port")

    hostname = parsed.hostname.lower().rstrip(".")
    if hostname == "localhost" or hostname.endswith((".localhost", ".local", ".internal")):
        raise UnsafeSourceUrl("source URL cannot target a local hostname")
    try:
        address = ip_address(hostname)
    except ValueError:
        return
    if not address.is_global:
        raise UnsafeSourceUrl("source URL cannot target a non-public address")


def canonicalize_url(url: str) -> str:
    """Remove transport and marketing noise while preserving source identity."""

    parsed = urlsplit(url.strip())
    scheme = parsed.scheme.lower()
    hostname = (parsed.hostname or "").lower()
    port = parsed.port
    if port and not ((scheme == "https" and port == 443) or (scheme == "http" and port == 80)):
        hostname = f"{hostname}:{port}"

    path = re.sub(r"/{2,}", "/", parsed.path).rstrip("/") or "/"
    query = [
        (key, value)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        if not key.lower().startswith("utm_") and key.lower() not in TRACKING_PARAMETERS
    ]
    return urlunsplit((scheme, hostname, path, urlencode(sorted(query)), ""))


def opportunity_fingerprint(
    *, institution: str, title: str, supervisor: str, deadline: str
) -> str:
    """Return a stable cross-source identity hint for likely duplicates."""

    normalized_supervisor = _words(supervisor)
    if normalized_supervisor.startswith("dr "):
        normalized_supervisor = normalized_supervisor[3:]
    parts = (_words(institution), _words(title), normalized_supervisor, deadline[:10])
    return sha256("\x1f".join(parts).encode()).hexdigest()


def _words(value: str) -> str:
    value = normalize("NFKD", value).encode("ascii", "ignore").decode().lower()
    value = value.replace("ph.d.", "phd")
    return " ".join(re.sub(r"[^a-z0-9]+", " ", value).split())
