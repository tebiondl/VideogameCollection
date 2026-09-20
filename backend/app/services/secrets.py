"""Small local secret wrapper. Windows uses DPAPI bound to this machine."""
from __future__ import annotations

import base64
import ctypes
import os
from ctypes import wintypes


PREFIX = "dpapi:v1:"


class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


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


def protect_secret(value: str | None) -> str | None:
    if not value or value.startswith(PREFIX):
        return value
    if os.name != "nt":
        # On non-Windows deployments require the key through the environment rather
        # than pretending plaintext database storage is protected.
        return None
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
        return PREFIX + base64.b64encode(encrypted).decode("ascii")
    finally:
        kernel32.LocalFree(ctypes.cast(output.pbData, ctypes.c_void_p))


def reveal_secret(value: str | None) -> str | None:
    if not value:
        return None
    if not value.startswith(PREFIX):
        return value  # Legacy plaintext is accepted only until the startup migration encrypts it.
    if os.name != "nt":
        return None
    encrypted = base64.b64decode(value[len(PREFIX):])
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

