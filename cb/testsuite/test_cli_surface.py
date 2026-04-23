from click.testing import CliRunner

from cb.main import cli


runner = CliRunner()


def test_job_create_help_has_no_pipeline_and_has_filter_options():
    result = runner.invoke(cli, ["job", "create", "--help"])
    assert result.exit_code == 0
    assert "pipeline" not in result.output.lower()

    freestyle_help = runner.invoke(cli, ["job", "create", "freestyle", "--help"])
    assert freestyle_help.exit_code == 0
    assert "--email-keyword" in freestyle_help.output
    assert "--email-regex" in freestyle_help.output


def test_job_update_help_has_no_pipeline_and_has_clear_flags():
    result = runner.invoke(cli, ["job", "update", "--help"])
    assert result.exit_code == 0
    assert "pipeline" not in result.output.lower()

    freestyle_help = runner.invoke(cli, ["job", "update", "freestyle", "--help"])
    assert freestyle_help.exit_code == 0
    assert "--email-keyword" in freestyle_help.output
    assert "--email-regex" in freestyle_help.output
    assert "--clear-email-keywords" in freestyle_help.output
    assert "--clear-email-regex" in freestyle_help.output
