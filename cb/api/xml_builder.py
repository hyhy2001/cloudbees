from __future__ import annotations
"""Config XML builders for Jobs, Nodes, Credentials -- using stdlib xml.etree."""

import xml.etree.ElementTree as ET


def _xml_str(root: ET.Element) -> str:
    """Serialise an ElementTree to a UTF-8 XML string with declaration."""
    ET.indent(root, space="  ")
    return (
        "<?xml version='1.1' encoding='UTF-8'?>\n"
        + ET.tostring(root, encoding="unicode")
    )


# -- Job XML ---------------------------------------------------


def inject_email_publisher(publishers: ET.Element, email: str, email_cond: str):
    """Helper to inject ExtendedEmailPublisher into publishers block."""
    ext_mail = ET.SubElement(publishers, "hudson.plugins.emailext.ExtendedEmailPublisher", {"plugin": "email-ext"})
    ET.SubElement(ext_mail, "recipientList").text = email
    ET.SubElement(ext_mail, "configuredTriggers")
    cur_triggers = ext_mail.find("configuredTriggers")
    
    def _add_email_trigger(parent, tag_name):
        evt = ET.SubElement(parent, tag_name)
        eml = ET.SubElement(evt, "email")
        ET.SubElement(eml, "subject").text = "$PROJECT_DEFAULT_SUBJECT"
        ET.SubElement(eml, "body").text = "$PROJECT_DEFAULT_CONTENT"
        ET.SubElement(eml, "recipientList").text = ""
        rp = ET.SubElement(eml, "recipientProviders")
        ET.SubElement(rp, "hudson.plugins.emailext.plugins.recipients.ListRecipientProvider")
        ET.SubElement(eml, "attachmentsPattern").text = ""
        ET.SubElement(eml, "attachBuildLog").text = "false"
        ET.SubElement(eml, "compressBuildLog").text = "false"
        ET.SubElement(eml, "replyTo").text = "$PROJECT_DEFAULT_REPLYTO"
        ET.SubElement(eml, "contentType").text = "project"

    if email_cond in ("failed", "always"):
        _add_email_trigger(cur_triggers, "hudson.plugins.emailext.plugins.trigger.FailureTrigger")
    if email_cond in ("success", "always"):
        _add_email_trigger(cur_triggers, "hudson.plugins.emailext.plugins.trigger.SuccessTrigger")
        
    ET.SubElement(ext_mail, "contentType").text = "default"
    ET.SubElement(ext_mail, "defaultSubject").text = "$DEFAULT_SUBJECT"
    ET.SubElement(ext_mail, "defaultContent").text = "$DEFAULT_CONTENT"
    ET.SubElement(ext_mail, "attachmentsPattern").text = ""
    ET.SubElement(ext_mail, "presendScript").text = "$DEFAULT_PRESEND_SCRIPT"
    ET.SubElement(ext_mail, "postsendScript").text = "$DEFAULT_POSTSEND_SCRIPT"
    ET.SubElement(ext_mail, "attachBuildLog").text = "false"
    ET.SubElement(ext_mail, "compressBuildLog").text = "false"
    ET.SubElement(ext_mail, "replyTo").text = "$DEFAULT_REPLYTO"
    ET.SubElement(ext_mail, "from").text = ""
    ET.SubElement(ext_mail, "saveOutput").text = "false"
    ET.SubElement(ext_mail, "disabled").text = "false"

def build_freestyle_xml(
        desc: str = "", 
        shell_cmd: str = "echo hello", 
        node: str | None = None,
        chdir: str | None = None,
        schedule: str | None = None,
        email: str | None = None,
        email_cond: str = "failed"
) -> str:
    """Freestyle project config.xml."""
    root = ET.Element("project")
    ET.SubElement(root, "description").text = desc
    ET.SubElement(root, "keepDependencies").text = "false"
    ET.SubElement(root, "properties")
    ET.SubElement(root, "scm", {"class": "hudson.scm.NullSCM"})
    ET.SubElement(root, "canRoam").text = "false" if node else "true"
    if node:
        ET.SubElement(root, "assignedNode").text = node
    ET.SubElement(root, "disabled").text = "false"
    
    triggers = ET.SubElement(root, "triggers")
    if schedule:
        timer = ET.SubElement(triggers, "hudson.triggers.TimerTrigger")
        ET.SubElement(timer, "spec").text = schedule
        
    builders = ET.SubElement(root, "builders")
    shell = ET.SubElement(builders, "hudson.tasks.Shell")
    final_cmd = f"cd {chdir} && {shell_cmd}" if chdir else shell_cmd
    ET.SubElement(shell, "command").text = final_cmd
    
    publishers = ET.SubElement(root, "publishers")
    if email:
        inject_email_publisher(publishers, email, email_cond)

    ET.SubElement(root, "buildWrappers")
    return _xml_str(root)



def build_pipeline_xml(
        desc: str = "", 
        script: str = "pipeline { agent any\n  stages { stage('Build') { steps { echo 'Hello' } } } }", 
        node: str | None = None,
        schedule: str | None = None
) -> str:
    """Pipeline (WorkflowJob) config.xml."""
    root = ET.Element(
        "flow-definition",
        {"plugin": "workflow-job"}
    )
    ET.SubElement(root, "description").text = desc

    if node:
        ET.SubElement(root, "assignedNode").text = node

    actions = ET.SubElement(root, "actions")
    defn = ET.SubElement(
        root, "definition",
        {"class": "org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition",
         "plugin": "workflow-cps"}
    )
    ET.SubElement(defn, "script").text = script
    ET.SubElement(defn, "sandbox").text = "true"
    
    triggers = ET.SubElement(root, "triggers")
    if schedule:
        timer = ET.SubElement(triggers, "hudson.triggers.TimerTrigger")
        ET.SubElement(timer, "spec").text = schedule
        
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


# -- Node XML --------------------------------------------------

def build_permanent_node_xml(
    name: str,
    remote_dir: str,
    num_executors: int = 1,
    labels: str = "",
    desc: str = "",
    host: str = "",
    port: int = 22,
    credentials_id: str = "",
) -> str:
    """Config XML for Permanent Agent (SSH or JNLP)."""
    root = ET.Element("slave")
    ET.SubElement(root, "name").text = name
    ET.SubElement(root, "description").text = desc
    ET.SubElement(root, "remoteFS").text = remote_dir
    ET.SubElement(root, "numExecutors").text = str(num_executors)
    ET.SubElement(root, "mode").text = "NORMAL"
    ET.SubElement(root, "retentionStrategy", {"class": "hudson.slaves.RetentionStrategy$Always"})
    
    if host:
        launcher = ET.SubElement(root, "launcher", {"class": "hudson.plugins.sshslaves.SSHLauncher", "plugin": "ssh-slaves"})
        ET.SubElement(launcher, "host").text = host
        ET.SubElement(launcher, "port").text = str(port)
        ET.SubElement(launcher, "credentialsId").text = credentials_id
        ET.SubElement(launcher, "sshHostKeyVerificationStrategy", {"class": "hudson.plugins.sshslaves.verifiers.NonVerifyingKeyVerificationStrategy"})
    else:
        launcher = ET.SubElement(root, "launcher", {"class": "hudson.slaves.JNLPLauncher"})
        wds = ET.SubElement(launcher, "workDirSettings")
        ET.SubElement(wds, "disabled").text = "false"
        ET.SubElement(wds, "internalDir").text = "remoting"
        ET.SubElement(wds, "failIfWorkDirIsMissing").text = "false"
        
    ET.SubElement(root, "label").text = labels
    ET.SubElement(root, "nodeProperties")
    return _xml_str(root)


# -- Credential XML --------------------------------------------


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
