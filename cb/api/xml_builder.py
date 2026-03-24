from __future__ import annotations
"""Config XML builders for Jobs, Nodes, Credentials — using stdlib xml.etree."""

import xml.etree.ElementTree as ET


def _xml_str(root: ET.Element) -> str:
    """Serialise an ElementTree to a UTF-8 XML string with declaration."""
    ET.indent(root, space="  ")
    return (
        "<?xml version='1.1' encoding='UTF-8'?>\n"
        + ET.tostring(root, encoding="unicode")
    )


# ── Job XML ───────────────────────────────────────────────────


def build_freestyle_xml(desc: str = "", shell_cmd: str = "echo hello") -> str:
    """Freestyle project config.xml."""
    root = ET.Element("project")
    ET.SubElement(root, "description").text = desc
    ET.SubElement(root, "keepDependencies").text = "false"
    ET.SubElement(root, "properties")
    ET.SubElement(root, "scm", {"class": "hudson.scm.NullSCM"})
    ET.SubElement(root, "canRoam").text = "true"
    ET.SubElement(root, "disabled").text = "false"
    builders = ET.SubElement(root, "builders")
    shell = ET.SubElement(builders, "hudson.tasks.Shell")
    ET.SubElement(shell, "command").text = shell_cmd
    ET.SubElement(root, "publishers")
    ET.SubElement(root, "buildWrappers")
    return _xml_str(root)


def build_pipeline_xml(desc: str = "", script: str = "pipeline { agent any\n  stages { stage('Build') { steps { echo 'Hello' } } } }") -> str:
    """Pipeline (WorkflowJob) config.xml."""
    root = ET.Element(
        "flow-definition",
        {"plugin": "workflow-job"}
    )
    ET.SubElement(root, "description").text = desc
    actions = ET.SubElement(root, "actions")
    defn = ET.SubElement(
        root, "definition",
        {"class": "org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition",
         "plugin": "workflow-cps"}
    )
    ET.SubElement(defn, "script").text = script
    ET.SubElement(defn, "sandbox").text = "true"
    ET.SubElement(root, "triggers")
    ET.SubElement(root, "disabled").text = "false"
    return _xml_str(root)


def build_folder_xml(desc: str = "") -> str:
    """CloudBees Folder config.xml."""
    root = ET.Element(
        "com.cloudbees.hudson.plugins.folder.Folder",
        {"plugin": "cloudbees-folder"}
    )
    ET.SubElement(root, "description").text = desc
    ET.SubElement(root, "views")
    ET.SubElement(root, "primaryView").text = "All"
    ET.SubElement(root, "healthMetrics")
    return _xml_str(root)


# ── Node XML ──────────────────────────────────────────────────


def build_permanent_node_xml(
    name: str,
    remote_dir: str,
    num_executors: int = 1,
    labels: str = "",
    desc: str = "",
) -> str:
    """Permanent Agent (JNLP/Inbound) config.xml."""
    root = ET.Element("slave")
    ET.SubElement(root, "name").text = name
    ET.SubElement(root, "description").text = desc
    ET.SubElement(root, "remoteFS").text = remote_dir
    ET.SubElement(root, "numExecutors").text = str(num_executors)
    ET.SubElement(root, "mode").text = "NORMAL"
    ET.SubElement(
        root, "retentionStrategy",
        {"class": "hudson.slaves.RetentionStrategy$Always"}
    )
    ET.SubElement(
        root, "launcher",
        {"class": "hudson.slaves.JNLPLauncher", "tunnel": "", "vmargs": ""}
    )
    ET.SubElement(root, "label").text = labels
    ET.SubElement(root, "nodeProperties")
    return _xml_str(root)


def patch_node_xml(source_xml: str, new_name: str) -> str:
    """
    Take an existing node config.xml and replace its <name> tag.
    Used for 'copy node' functionality.
    """
    root = ET.fromstring(source_xml)
    name_el = root.find("name")
    if name_el is not None:
        name_el.text = new_name
    return _xml_str(root)


# ── Credential XML ────────────────────────────────────────────


def build_username_password_cred_xml(
    cred_id: str,
    username: str,
    password: str,
    desc: str = "",
    scope: str = "GLOBAL",
) -> str:
    """UsernamePassword credential config.xml."""
    root = ET.Element(
        "com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl"
    )
    ET.SubElement(root, "scope").text = scope
    ET.SubElement(root, "id").text = cred_id
    ET.SubElement(root, "description").text = desc
    ET.SubElement(root, "username").text = username
    ET.SubElement(root, "password").text = password
    return _xml_str(root)
