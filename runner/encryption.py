"""
AES-256-GCM decryption compatible with the TypeScript lib/encryption.ts.
Format: iv:authTag:ciphertext (all hex-encoded)
"""
import os
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def decrypt(ciphertext: str) -> str:
    """Decrypt a value encrypted by the TypeScript encrypt() function."""
    key_hex = os.environ.get("ENCRYPTION_KEY", "")
    if not key_hex:
        raise ValueError("ENCRYPTION_KEY environment variable is not set")
    
    key = bytes.fromhex(key_hex)
    
    parts = ciphertext.split(":")
    if len(parts) != 3:
        raise ValueError("Invalid ciphertext format — expected iv:authTag:ciphertext")
    
    iv = bytes.fromhex(parts[0])
    auth_tag = bytes.fromhex(parts[1])
    encrypted = bytes.fromhex(parts[2])
    
    # AESGCM expects the auth tag appended to the ciphertext
    aesgcm = AESGCM(key)
    decrypted = aesgcm.decrypt(iv, encrypted + auth_tag, None)
    
    return decrypted.decode("utf-8")
