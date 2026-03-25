from __future__ import annotations
"""cb users commands."""

import click
from cb.services.auth_service import get_client
from cb.services.user_service import list_users, get_user
from cb.cli.formatters import format_table, format_kv


@click.group("users")
def users_group():
    """List and inspect CloudBees users."""


def _client(ctx):
    return get_client(
        profile_name=ctx.obj.get("profile"),
        db_path=ctx.obj.get("db_path"),
    )


@users_group.command("list")
@click.pass_context
def cmd_list(ctx):
    """List all users."""
    try:
        users = list_users(_client(ctx))
        rows = [[u.id, u.full_name, u.description[:40]] for u in users]
        click.echo(format_table(["ID", "Full Name", "Description"], rows))
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


@users_group.command("get")
@click.argument("user_id")
@click.pass_context
def cmd_get(ctx, user_id):
    """Show details for a specific user."""
    try:
        user = get_user(_client(ctx), user_id)
        click.echo(format_kv(user.to_dict()))
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)
