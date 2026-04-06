"""
AES-256-GCM encryption/decryption compatible with the TypeScript lib/encryption.ts.
Format: iv:authTag:ciphertext (all hex-encoded)
"""
import os
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def _get_key() -> bytes:
    key_hex = os.environ.get("ENCRYPTION_KEY", "")
    if not key_hex:
        raise ValueError("ENCRYPTION_KEY environment variable is not set")
    return bytes.fromhex(key_hex)


def encrypt(plaintext: str) -> str:
    """Encrypt a value using the same format as the TypeScript encrypt() function."""
    key = _get_key()
    iv = os.urandom(16)
    aesgcm = AESGCM(key)
    ct_with_tag = aesgcm.encrypt(iv, plaintext.encode("utf-8"), None)
    # AESGCM appends the 16-byte auth tag to the ciphertext
    ciphertext = ct_with_tag[:-16]
    auth_tag = ct_with_tag[-16:]
    return f"{iv.hex()}:{auth_tag.hex()}:{ciphertext.hex()}"


def decrypt(ciphertext: str) -> str:
    """Decrypt a value encrypted by the TypeScript encrypt() function."""
    key = _get_key()

    parts = ciphertext.split(":")
    if len(parts) != 3:
        raise ValueError("Invalid ciphertext format — expected iv:authTag:ciphertext")

    iv = bytes.fromhex(parts[0])
    auth_tag = bytes.fromhex(parts[1])
    encrypted = bytes.fromhex(parts[2])

    aesgcm = AESGCM(key)
    decrypted = aesgcm.decrypt(iv, encrypted + auth_tag, None)

    return decrypted.decode("utf-8")
