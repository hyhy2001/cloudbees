from __future__ import annotations
"""cb users commands."""

import click
from cb.services.auth_service import get_client
from cb.services.user_service import list_users, get_user
from cb.cli.formatters import format_table, format_json, format_kv


@click.group("users")
def users_group():
    """List and inspect CloudBees users."""


def _client(ctx):
    return get_client(
        profile_name=ctx.obj.get("profile"),
        password=ctx.obj.get("password"),
        db_path=ctx.obj.get("db_path"),
    )


@users_group.command("list")
@click.option("--output", "-o", default="table", type=click.Choice(["table", "json"]))
@click.pass_context
def cmd_list(ctx, output):
    """List all users."""
    try:
        users = list_users(_client(ctx))
        if output == "json":
            click.echo(format_json([u.to_dict() for u in users]))
        else:
            rows = [[u.id, u.full_name, u.description[:40]] for u in users]
            click.echo(format_table(["ID", "Full Name", "Description"], rows))
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


@users_group.command("get")
@click.argument("user_id")
@click.option("--output", "-o", default="table", type=click.Choice(["table", "json"]))
@click.pass_context
def cmd_get(ctx, user_id, output):
    """Show details for a specific user."""
    try:
        user = get_user(_client(ctx), user_id)
        if output == "json":
            click.echo(format_json(user.to_dict()))
        else:
            click.echo(format_kv(user.to_dict()))
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)
