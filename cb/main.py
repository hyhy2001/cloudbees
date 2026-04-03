"""bee -- CloudBees CLI + TUI entry point."""

import os
import sys
import logging
from pathlib import Path

import click

from cb.db.connection import init_db
from cb.cli.commands.auth import auth_group
from cb.cli.commands.jobs import jobs_group
from cb.cli.commands.controller import controller_group
from cb.cli.commands.credentials import cred_group
from cb.cli.commands.nodes import node_group

__version__ = "0.3.0"


@click.group(invoke_without_command=True)
@click.version_option(__version__, prog_name="bee")
@click.option("--ui", is_flag=True, default=False, help="Launch the TUI interface")
@click.option("--debug", is_flag=True, default=False, help="Enable debug logging")
@click.pass_context
def cli(ctx, ui, debug):
    """bee - CloudBees command-line tool.

    \b
    Usage:
      bee auth login                   # Interactive login
      bee controller list              # List controllers
      bee controller select <name>     # Select active controller
      bee job list                     # List jobs
      bee job create freestyle <name>  # Create a Freestyle job
      bee cred create --id x --username u  # Create credential
      bee node list                    # List agent nodes
      bee --ui                         # Launch TUI interface
    """
    if debug:
        logging.basicConfig(level=logging.DEBUG, stream=sys.stderr, format="%(levelname)s %(name)s %(message)s")

    init_db()

    ctx.ensure_object(dict)
    ctx.obj["profile"] = None
    ctx.obj["controller"] = None
    ctx.obj["token"] = None
    ctx.obj["db_path"] = None
    ctx.obj["debug"] = debug

    if ui:
        _launch_tui(None, None, None, None)
        return

    if ctx.invoked_subcommand is None:
        click.echo(ctx.get_help())


def _launch_tui(profile, controller, token, db_path):
    """Bootstrap the Textual TUI."""
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    try:
        from cb.tui.app import main as tui_main
        tui_main(db_path=db_path)
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        click.echo(f"[ERROR] TUI failed: {exc}", err=True)
        import traceback
        traceback.print_exc()
        sys.exit(1)


# Register all command groups
cli.add_command(auth_group, name="auth")
cli.add_command(controller_group, name="controller")
cli.add_command(jobs_group, name="job")
cli.add_command(cred_group, name="cred")
cli.add_command(node_group, name="node")


if __name__ == "__main__":
    cli()
