"""cb CLI — auth commands: login, logout, profile."""

from __future__ import annotations
import click
from cb.services.auth_service import login, logout
from cb.db.repositories.profile_repo import list_profiles
from cb.cli.formatters import format_table


@click.group("auth")
def auth_group():
    """Authentication and profile management."""


@auth_group.command("login")
@click.option("--url", prompt="Server URL", help="CloudBees server URL")
@click.option("--username", prompt="Username", help="Your username")
@click.option("--password", prompt="Password", hide_input=True, help="Your password")
@click.option("--profile", default="default", show_default=True, help="Profile name")
@click.pass_context
def cmd_login(ctx, url, username, password, profile):
    """Login to a CloudBees server and save encrypted credentials."""
    try:
        p = login(server_url=url, username=username, password=password,
                  profile_name=profile, is_default=True,
                  db_path=ctx.obj.get("db_path"))
        click.echo(f"[OK] Logged in as '{p.username}' on {p.server_url}")
        click.echo(f"     Profile: {p.name}")
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


@auth_group.command("logout")
@click.option("--profile", default=None, help="Profile to logout (default: active)")
@click.pass_context
def cmd_logout(ctx, profile):
    """Remove stored token for a profile."""
    logout(profile_name=profile, db_path=ctx.obj.get("db_path"))
    click.echo("[OK] Logged out.")


@auth_group.command("profiles")
@click.pass_context
def cmd_profiles(ctx):
    """List all saved profiles."""
    profiles = list_profiles(ctx.obj.get("db_path"))
    if not profiles:
        click.echo("No profiles found. Run: cb login")
        return
    rows = [
        [p.name, p.server_url, p.username, "*" if p.is_default else ""]
        for p in profiles
    ]
    click.echo(format_table(["Profile", "Server", "Username", "Default"], rows))
