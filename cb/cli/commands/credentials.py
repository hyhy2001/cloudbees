from __future__ import annotations
"""cb cred — list, get, create (username+password), delete."""

import click
from cb.cli.formatters import format_table, format_kv


@click.group("cred")
def cred_group():
    """Manage CloudBees credentials."""


def _client(ctx):
    from cb.services.auth_service import get_client
    return get_client(profile_name=ctx.obj.get("profile"))


@cred_group.command("list")
@click.pass_context
def cmd_list(ctx):
    """List all credentials."""
    from cb.services.credential_service import list_credentials
    try:
        creds = list_credentials(_client(ctx))
        headers = ["ID", "Type", "Description", "Scope"]
        rows = [[c.id, c.type_name[:25], (c.description or "")[:35], c.scope] for c in creds]
        click.echo(format_table(headers, rows))
        click.echo(f"  {len(creds)} credential(s)")
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


@cred_group.command("get")
@click.argument("cred_id")
@click.pass_context
def cmd_get(ctx, cred_id):
    """Show credential details (secrets are masked)."""
    from cb.services.credential_service import get_credential
    try:
        cred = get_credential(_client(ctx), cred_id)
        data = cred.to_dict()
        # Mask any field that looks like a secret
        for k in list(data.keys()):
            if any(s in k.lower() for s in ("password", "secret", "key", "token")):
                data[k] = "[HIDDEN]"
        click.echo(format_kv(data))
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


@cred_group.command("create")
@click.option("--id", "cred_id", default=None, help="Unique credential ID (auto-generated if omitted)")
@click.option("--username", required=True, help="Username")
@click.option("--password", default=None, help="Password (prompted if omitted)")
@click.option("--description", default="", help="Description")
@click.option("--scope", default="GLOBAL", type=click.Choice(["GLOBAL", "SYSTEM"]))
@click.pass_context
def cmd_create(ctx, cred_id, username, password, description, scope):
    """Create a Username+Password credential."""
    from cb.services.credential_service import create_username_password
    import uuid
    try:
        if not cred_id:
            cred_id = str(uuid.uuid4())
        if not password:
            password = click.prompt(
                f"Password for '{username}'",
                hide_input=True,
                confirmation_prompt=False,
            )
        create_username_password(
            _client(ctx),
            cred_id=cred_id,
            username=username,
            password=password,
            desc=description,
            scope=scope,
        )
        click.echo(f"[OK] Credential '{cred_id}' created.")
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


@cred_group.command("delete")
@click.argument("cred_id")
@click.option("--yes", is_flag=True, default=False, help="Skip confirmation")
@click.pass_context
def cmd_delete(ctx, cred_id, yes):
    """Delete a credential."""
    from cb.services.credential_service import delete_credential
    try:
        if not yes:
            click.confirm(f"Delete credential '{cred_id}'?", abort=True)
        delete_credential(_client(ctx), cred_id)
        click.echo(f"[OK] Credential '{cred_id}' deleted.")
    except click.Abort:
        click.echo("Cancelled.")
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)


@cred_group.command("update")
@click.argument("cred_id")
@click.argument("xml_file", type=click.File("r"))
@click.pass_context
def cmd_update(ctx, cred_id, xml_file):
    """Update a credential using a config.xml file."""
    from cb.services.credential_service import update_credential
    try:
        update_credential(_client(ctx), cred_id, xml_file.read())
        click.echo(f"[OK] Credential '{cred_id}' updated.")
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        raise SystemExit(1)
