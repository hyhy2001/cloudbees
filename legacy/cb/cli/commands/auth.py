"""cb CLI -- auth commands: login, logout, profile."""

from __future__ import annotations
import click
from cb.cli.console import console, print_error
from cb.services.auth_service import login, logout
from cb.db.repositories.profile_repo import list_profiles, delete_profile
from cb.cli.formatters import format_table


@click.group("auth")
def auth_group():
    """Authentication and profile management."""


@auth_group.command("login")
@click.option("--url", prompt="Server URL", help="CloudBees server URL")
@click.option("--username", prompt="Username", help="Your username")
@click.option("--token", prompt="API Token", hide_input=True, help="Your API Token")
@click.option("--profile", default="default", show_default=True, help="Profile name")
@click.pass_context
def cmd_login(ctx, url, username, token, profile):
    """Login to a CloudBees server and save API Token."""
    try:
        p = login(server_url=url, username=username, password=token,
                  profile_name=profile, is_default=True,
                  db_path=ctx.obj.get("db_path"))
        console.print(f"[success]OK[/success] Logged in as '{p.username}' on {p.server_url}")
        console.print(f"     Profile: {p.name}")
    except Exception as exc:
        print_error(str(exc), exc)
        raise SystemExit(1)


@auth_group.command("logout")
@click.option("--profile", default=None, help="Profile to logout (default: active)")
@click.pass_context
def cmd_logout(ctx, profile):
    """Remove stored token for a profile."""
    logout(profile_name=profile, db_path=ctx.obj.get("db_path"))
    console.print("[success]OK[/success] Logged out.")


@auth_group.command("delete")
@click.option("--profile", required=True, help="Profile name to delete")
@click.pass_context
def cmd_delete(ctx, profile):
    """Delete a saved profile."""
    try:
        delete_profile(profile, db_path=ctx.obj.get("db_path"))
        console.print(f"[success]OK[/success] Profile '{profile}' deleted.")
    except Exception as exc:
        console.print(f"[ERROR] Failed to delete profile: {exc}", err=True)
        raise SystemExit(1)


@auth_group.command("profiles")
@click.pass_context
def cmd_profiles(ctx):
    """List all saved profiles."""
    profiles = list_profiles(ctx.obj.get("db_path"))
    if not profiles:
        console.print("No profiles found. Run: cb login")
        return
    rows = [
        [p.name, p.server_url, p.username, "*" if p.is_default else ""]
        for p in profiles
    ]
    console.print(format_table(["Profile", "Server", "Username", "Default"], rows))
