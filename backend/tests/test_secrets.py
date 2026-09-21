import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.app.services import secrets


class SteamSecretTests(unittest.TestCase):
    def test_linux_key_is_encrypted_and_survives_reloading_key_file(self):
        with tempfile.TemporaryDirectory() as directory:
            key_file = Path(directory) / "steam.key"
            environment = {
                "STEAM_SECRET_KEY_FILE": str(key_file),
                "STEAM_SECRET_ENCRYPTION_KEY": "",
                "STEAM_WEB_API_KEY": "",
            }
            with patch.object(secrets, "_is_windows", return_value=False), patch.dict(os.environ, environment):
                protected = secrets.protect_secret("a" * 32)
                self.assertTrue(protected.startswith(secrets.FERNET_PREFIX))
                self.assertNotIn("a" * 32, protected)
                self.assertEqual(secrets.reveal_secret(protected), "a" * 32)
                self.assertTrue(key_file.exists())
                self.assertEqual(len(key_file.read_bytes()), 44)

    def test_server_wide_key_is_used_when_user_has_no_saved_key(self):
        with patch.dict(os.environ, {"STEAM_WEB_API_KEY": "b" * 32}):
            self.assertEqual(secrets.resolve_steam_api_key(None), "b" * 32)
            self.assertTrue(secrets.steam_api_key_available(None))

    def test_wrong_linux_encryption_key_requires_reentry(self):
        with patch.object(secrets, "_is_windows", return_value=False), \
             patch.dict(os.environ, {"STEAM_SECRET_ENCRYPTION_KEY": "first"}):
            protected = secrets.protect_secret("c" * 32)
        with patch.object(secrets, "_is_windows", return_value=False), \
             patch.dict(os.environ, {"STEAM_SECRET_ENCRYPTION_KEY": "second"}):
            with self.assertRaisesRegex(ValueError, "cannot be decrypted"):
                secrets.reveal_secret(protected)
            self.assertFalse(secrets.steam_api_key_available(protected))


if __name__ == "__main__":
    unittest.main()
