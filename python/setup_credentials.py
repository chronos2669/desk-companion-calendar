#!/usr/bin/env python3
"""
One-off credential setup for Calendar Desk Companion.

Stores an Apple ID and app-specific password in the system secret store
(KWallet on Fedora KDE, via the freedesktop Secret Service API).

Run once:  python setup_credentials.py
Clear:     python setup_credentials.py --clear
"""

import getpass
import sys

import keyring
from keyring.errors import KeyringError

SERVICE = "desk-companion-calendar"
USERNAME_KEY = "apple_id"
PASSWORD_KEY = "app_password"


def store() -> int:
    print("Desk Companion — credential setup\n")
    print("You need an app-specific password from account.apple.com")
    print("(Sign-In and Security → App-Specific Passwords).\n")

    apple_id = input("Apple ID email: ").strip()
    if not apple_id:
        print("No Apple ID entered. Nothing stored.", file=sys.stderr)
        return 1

    password = getpass.getpass("App-specific password: ").strip()
    if not password:
        print("No password entered. Nothing stored.", file=sys.stderr)
        return 1

    # Apple displays the password hyphenated, but accepts either form.
    # Normalize so a copy-paste with hyphens still works.
    password = password.replace("-", "")

    try:
        keyring.set_password(SERVICE, USERNAME_KEY, apple_id)
        keyring.set_password(SERVICE, PASSWORD_KEY, password)
    except KeyringError as exc:
        print(f"Could not write to the secret store: {exc}", file=sys.stderr)
        print("Check that kwalletd is running: systemctl --user status kwallet", file=sys.stderr)
        return 1

    print(f"\nStored under service '{SERVICE}'.")
    print("Verify with: secret-tool search service desk-companion-calendar")
    return 0


def clear() -> int:
    for key in (USERNAME_KEY, PASSWORD_KEY):
        try:
            keyring.delete_password(SERVICE, key)
        except KeyringError:
            pass
    print("Credentials cleared.")
    return 0


if __name__ == "__main__":
    if "--clear" in sys.argv:
        sys.exit(clear())
    sys.exit(store())