"""Verify HTTPS/WSS using the operating system's trusted certificates."""
from functools import lru_cache
import ssl

import truststore


@lru_cache(maxsize=1)
def tls_context():
    return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
