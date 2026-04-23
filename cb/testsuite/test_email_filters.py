import xml.etree.ElementTree as ET

import pytest

from cb.api.xml_builder import build_freestyle_xml, parse_email_filter_metadata
from cb.services.job_service import create_freestyle_job, update_job_freestyle


class FakeClient:
    def __init__(self, config_xml: str = ""):
        self._config_xml = config_xml
        self.posted = []

    def get_text(self, path: str):
        return self._config_xml

    def post_xml(self, path: str, xml_str: str, invalidate: str):
        self.posted.append({"path": path, "xml": xml_str, "invalidate": invalidate})


def _extract_meta_from_xml(xml_text: str):
    root = ET.fromstring(xml_text)
    pub = root.find("publishers")
    assert pub is not None
    ext = pub.find("hudson.plugins.emailext.ExtendedEmailPublisher")
    assert ext is not None
    presend = ext.find("presendScript")
    assert presend is not None
    return parse_email_filter_metadata(presend.text)


def _extract_recipient(xml_text: str):
    root = ET.fromstring(xml_text)
    pub = root.find("publishers")
    assert pub is not None
    ext = pub.find("hudson.plugins.emailext.ExtendedEmailPublisher")
    assert ext is not None
    recipient = ext.find("recipientList")
    assert recipient is not None
    return (recipient.text or "").strip()


def test_build_freestyle_xml_with_filter_embeds_metadata_and_script():
    xml = build_freestyle_xml(
        desc="d",
        shell_cmd="echo hi",
        email="ops@example.com",
        email_cond="failed",
        email_keywords=["CRITICAL", "panic"],
        email_regex="OOM|OutOfMemory",
    )
    meta = _extract_meta_from_xml(xml)
    assert meta is not None
    assert meta["keywords"] == ["CRITICAL", "panic"]
    assert meta["regex"] == "OOM|OutOfMemory"
    assert meta["case_sensitive"] is False


def test_build_freestyle_xml_without_filter_keeps_default_presend_script():
    xml = build_freestyle_xml(
        desc="d",
        shell_cmd="echo hi",
        email="ops@example.com",
        email_cond="failed",
    )
    root = ET.fromstring(xml)
    presend = root.find("publishers/hudson.plugins.emailext.ExtendedEmailPublisher/presendScript")
    assert presend is not None
    assert presend.text == "$DEFAULT_PRESEND_SCRIPT"


def test_update_freestyle_filter_partial_update_keeps_existing_email_and_regex():
    existing = build_freestyle_xml(
        shell_cmd="echo old",
        email="ops@example.com",
        email_cond="failed",
        email_keywords=["OLD"],
        email_regex="OOM",
    )
    client = FakeClient(config_xml=existing)

    update_job_freestyle(
        client,
        name="demo",
        email_keywords=["NEW", "panic"],
    )

    assert len(client.posted) == 1
    posted_xml = client.posted[0]["xml"]
    assert _extract_recipient(posted_xml) == "ops@example.com"

    meta = _extract_meta_from_xml(posted_xml)
    assert meta is not None
    assert meta["keywords"] == ["NEW", "panic"]
    assert meta["regex"] == "OOM"


def test_update_freestyle_clear_regex_keeps_keywords():
    existing = build_freestyle_xml(
        shell_cmd="echo old",
        email="ops@example.com",
        email_cond="failed",
        email_keywords=["ALERT"],
        email_regex="OOM",
    )
    client = FakeClient(config_xml=existing)

    update_job_freestyle(
        client,
        name="demo",
        clear_email_regex=True,
    )

    posted_xml = client.posted[0]["xml"]
    meta = _extract_meta_from_xml(posted_xml)
    assert meta is not None
    assert meta["keywords"] == ["ALERT"]
    assert meta["regex"] is None


def test_create_or_update_filter_without_recipient_fails_fast():
    create_client = FakeClient()
    with pytest.raises(ValueError):
        create_freestyle_job(
            create_client,
            name="n1",
            shell_cmd="echo hi",
            email=None,
            email_keywords=["CRITICAL"],
        )

    existing = build_freestyle_xml(shell_cmd="echo hi", email=None)
    update_client = FakeClient(config_xml=existing)
    with pytest.raises(ValueError):
        update_job_freestyle(
            update_client,
            name="n1",
            email_keywords=["CRITICAL"],
        )


def test_update_clear_filter_flags_without_recipient_is_safe_noop():
    existing = build_freestyle_xml(shell_cmd="echo hi", email=None)
    client = FakeClient(config_xml=existing)

    update_job_freestyle(
        client,
        name="n1",
        clear_email_keywords=True,
        clear_email_regex=True,
    )

    posted_xml = client.posted[0]["xml"]
    root = ET.fromstring(posted_xml)
    ext = root.find("publishers/hudson.plugins.emailext.ExtendedEmailPublisher")
    assert ext is None
