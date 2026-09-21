"""Encrypt secrets at rest and resolve optional server-wide credentials."""
from __future__ import annotations

import base64
import ctypes
import hashlib
import os
from ctypes import wintypes
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken


DPAPI_PREFIX = "dpapi:v1:"
FERNET_PREFIX = "fernet:v1:"
# Compatibility for older imports and persisted values.
PREFIX = DPAPI_PREFIX


class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


def _is_windows() -> bool:
    return os.name == "nt"


def _blob(data: bytes):
    buffer = ctypes.create_string_buffer(data)
    return DATA_BLOB(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte))), buffer


def _windows_crypto():
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    crypt32.CryptProtectData.argtypes = [
        ctypes.POINTER(DATA_BLOB), wintypes.LPCWSTR, ctypes.c_void_p,
        ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(DATA_BLOB),
    ]
    crypt32.CryptProtectData.restype = wintypes.BOOL
    crypt32.CryptUnprotectData.argtypes = [
        ctypes.POINTER(DATA_BLOB), ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p,
        ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(DATA_BLOB),
    ]
    crypt32.CryptUnprotectData.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    return crypt32, kernel32


def _default_key_file() -> Path:
    configured = os.getenv("STEAM_SECRET_KEY_FILE", "").strip()
    if configured:
        return Path(configured)
    database_url = os.getenv("DATABASE_URL", "sqlite:///./videogames.db")
    if database_url.startswith("sqlite:///"):
        database_path = Path(database_url.removeprefix("sqlite:///"))
        return database_path.parent / ".steam-secrets.key"
    return Path("./data/.steam-secrets.key")


def _fernet_key() -> bytes:
    configured = os.getenv("STEAM_SECRET_ENCRYPTION_KEY", "").strip()
    if configured:
        # Treat the setting as a passphrase so operators do not have to generate
        # a correctly padded Fernet value and accidental whitespace is harmless.
        return base64.urlsafe_b64encode(hashlib.sha256(configured.encode("utf-8")).digest())

    path = _default_key_file()
    try:
        key = path.read_bytes().strip()
    except FileNotFoundError:
        path.parent.mkdir(parents=True, exist_ok=True)
        generated = Fernet.generate_key()
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            key = path.read_bytes().strip()
        else:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(generated)
            key = generated
    try:
        Fernet(key)
    except (ValueError, TypeError) as exc:
        raise ValueError(f"Invalid Steam secret encryption key file: {path}") from exc
    return key


def _protect_dpapi(value: str) -> str:
    source, source_buffer = _blob(value.encode("utf-8"))
    output = DATA_BLOB()
    crypt32, kernel32 = _windows_crypto()
    if not crypt32.CryptProtectData(
        # Machine scope lets the desktop app and background sync use different
        # Windows identities while copied database files remain unreadable.
        ctypes.byref(source), "VideogameCollection", None, None, None, 4,
        ctypes.byref(output),
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        encrypted = ctypes.string_at(output.pbData, output.cbData)
        return DPAPI_PREFIX + base64.b64encode(encrypted).decode("ascii")
    finally:
        kernel32.LocalFree(ctypes.cast(output.pbData, ctypes.c_void_p))


def protect_secret(value: str | None) -> str | None:
    if not value or value.startswith((DPAPI_PREFIX, FERNET_PREFIX)):
        return value
    if _is_windows():
        return _protect_dpapi(value)
    token = Fernet(_fernet_key()).encrypt(value.encode("utf-8")).decode("ascii")
    return FERNET_PREFIX + token


def _reveal_dpapi(value: str) -> str:
    if not _is_windows():
        raise ValueError("This API key was encrypted on Windows and cannot be read on this server. Enter it again.")
    encrypted = base64.b64decode(value[len(DPAPI_PREFIX):])
    source, source_buffer = _blob(encrypted)
    output = DATA_BLOB()
    crypt32, kernel32 = _windows_crypto()
    description = ctypes.c_void_p()
    if not crypt32.CryptUnprotectData(
        ctypes.byref(source), ctypes.byref(description), None, None, None, 0, ctypes.byref(output),
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(output.pbData, output.cbData).decode("utf-8")
    finally:
        kernel32.LocalFree(ctypes.cast(output.pbData, ctypes.c_void_p))
        if description.value:
            kernel32.LocalFree(description)


def reveal_secret(value: str | None) -> str | None:
    if not value:
        return None
    if value.startswith(FERNET_PREFIX):
        try:
            return Fernet(_fernet_key()).decrypt(value[len(FERNET_PREFIX):].encode("ascii")).decode("utf-8")
        except InvalidToken as exc:
            raise ValueError("The saved API key cannot be decrypted. Enter it again.") from exc
    if value.startswith(DPAPI_PREFIX):
        return _reveal_dpapi(value)
    return value  # Legacy plaintext is accepted until the startup migration encrypts it.


def resolve_steam_api_key(value: str | None) -> str | None:
    """Use a per-user saved key first, then the optional server-wide key."""
    revealed = reveal_secret(value)
    return (revealed or os.getenv("STEAM_WEB_API_KEY", "")).strip() or None


def steam_api_key_available(value: str | None) -> bool:
    try:
        return bool(resolve_steam_api_key(value))
    except (OSError, ValueError):
        return False
