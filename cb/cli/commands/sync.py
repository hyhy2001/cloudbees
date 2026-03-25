"""cb sync — pull data from cloudbees to local offline database."""

import click
from cb.cli.formatters import format_table

@click.command("sync")
@click.pass_context
def cmd_sync(ctx):
    """Synchronize all resources to the local portable database."""
    from cb.services.auth_service import get_client
    from cb.services.sync_service import sync_all

    client = get_client(
        profile_name=ctx.obj.get("profile"),
        db_path=ctx.obj.get("db_path"),
    )

    click.echo("Synchronizing resources with CloudBees Server...")
    try:
        counts = sync_all(client, ctx.obj.get("db_path"))
        
        rows = [
            ["Jobs", counts["jobs"]],
            ["Nodes", counts["nodes"]],
            ["Pipelines", counts["pipelines"]]
        ]
        click.echo("")
        click.echo(format_table(["Resource", "Synced Count"], rows))
        click.echo("\nSync complete! You can now browse resources offline.")
    except Exception as exc:
        click.echo(f"[ERROR] Sync failed: {exc}", err=True)
        raise SystemExit(1)
