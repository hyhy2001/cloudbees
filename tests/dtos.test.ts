/**
 * Unit tests for DTO factory functions.
 * No DB required — pure data transformation tests.
 */

import { describe, test, expect } from "bun:test";

import { jobFromDict, buildFromDict } from "../src/core/dtos/job";
import { nodeFromDict, nodeDetailFromDict } from "../src/core/dtos/node";
import { credentialFromDict } from "../src/core/dtos/credential";
import { controllerFromDict } from "../src/core/dtos/controller";
import { userFromDict, teamFromDict } from "../src/core/dtos/user";

// ---------------------------------------------------------------------------
// JobDTO
// ---------------------------------------------------------------------------

describe("jobFromDict", () => {
  test("FreeStyle _class → jobType 'FS'", () => {
    const job = jobFromDict({ _class: "hudson.model.FreeStyleProject", name: "j" });
    expect(job.jobType).toBe("FS");
  });

  test("WorkflowJob _class → jobType 'PL'", () => {
    const job = jobFromDict({ _class: "org.jenkinsci.plugins.workflow.job.WorkflowJob", name: "j" });
    expect(job.jobType).toBe("PL");
  });

  test("Folder _class → jobType 'FD'", () => {
    const job = jobFromDict({ _class: "com.cloudbees.hudson.plugins.folder.Folder", name: "j" });
    expect(job.jobType).toBe("FD");
  });

  test("MultiBranch _class → jobType 'MB'", () => {
    const job = jobFromDict({ _class: "org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject", name: "j" });
    expect(job.jobType).toBe("MB");
  });

  test("unknown _class → fallback (last dot-segment, first 4 chars)", () => {
    const job = jobFromDict({ _class: "com.example.SomethingNew", name: "j" });
    expect(job.jobType).toBe("Some");
  });

  test("empty _class → jobType ''", () => {
    const job = jobFromDict({ _class: "", name: "j" });
    expect(job.jobType).toBe("");
  });

  test("lastBuild.number maps correctly", () => {
    const job = jobFromDict({
      _class: "FreeStyleProject",
      name: "build-job",
      lastBuild: { number: 42, url: "https://ci/job/42/" },
    });
    expect(job.lastBuildNumber).toBe(42);
    expect(job.lastBuildUrl).toBe("https://ci/job/42/");
  });

  test("lastBuildNumber is null when lastBuild is null", () => {
    const job = jobFromDict({ _class: "FreeStyleProject", name: "j", lastBuild: null });
    expect(job.lastBuildNumber).toBeNull();
    expect(job.lastBuildUrl).toBeNull();
  });

  test("lastBuildNumber is null when lastBuild is missing", () => {
    const job = jobFromDict({ _class: "FreeStyleProject", name: "j" });
    expect(job.lastBuildNumber).toBeNull();
  });

  test("id equals name", () => {
    const job = jobFromDict({ _class: "FreeStyleProject", name: "my-job" });
    expect(job.id).toBe("my-job");
    expect(job.name).toBe("my-job");
  });

  test("buildable defaults to true when missing", () => {
    const job = jobFromDict({ _class: "FreeStyleProject", name: "j" });
    expect(job.buildable).toBe(true);
  });

  test("color defaults to empty string when missing", () => {
    const job = jobFromDict({ _class: "FreeStyleProject", name: "j" });
    expect(job.color).toBe("");
  });
});

// ---------------------------------------------------------------------------
// BuildDTO
// ---------------------------------------------------------------------------

describe("buildFromDict", () => {
  test("result is empty string when API returns null (in-progress)", () => {
    const build = buildFromDict({
      number: 10,
      result: null,
      building: true,
      duration: 0,
      timestamp: 1000000,
      url: "https://ci/job/10/",
    });
    expect(build.result).toBe("");
  });

  test("result is preserved when present", () => {
    const build = buildFromDict({ number: 5, result: "SUCCESS", building: false, duration: 1000, timestamp: 0, url: "" });
    expect(build.result).toBe("SUCCESS");
  });

  test("building defaults to false", () => {
    const build = buildFromDict({ number: 1, url: "" });
    expect(build.building).toBe(false);
  });

  test("number defaults to 0", () => {
    const build = buildFromDict({ url: "" });
    expect(build.number).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// NodeDTO
// ---------------------------------------------------------------------------

describe("nodeFromDict", () => {
  test("offline:true → offline:true (online would be false)", () => {
    const node = nodeFromDict({ displayName: "agent-1", offline: true });
    expect(node.offline).toBe(true);
  });

  test("offline:false → offline:false", () => {
    const node = nodeFromDict({ displayName: "agent-2", offline: false });
    expect(node.offline).toBe(false);
  });

  test("offline defaults to false when missing", () => {
    const node = nodeFromDict({ displayName: "agent-3" });
    expect(node.offline).toBe(false);
  });

  test("labels taken from first element of assignedLabels", () => {
    const node = nodeFromDict({
      displayName: "agent",
      assignedLabels: [{ name: "linux" }, { name: "docker" }],
    });
    expect(node.labels).toBe("linux");
  });

  test("labels empty when assignedLabels is empty array", () => {
    const node = nodeFromDict({ displayName: "agent", assignedLabels: [] });
    expect(node.labels).toBe("");
  });

  test("labels empty when assignedLabels is missing", () => {
    const node = nodeFromDict({ displayName: "agent" });
    expect(node.labels).toBe("");
  });

  test("name falls back to name field when displayName is empty", () => {
    const node = nodeFromDict({ displayName: "", name: "fallback-name" });
    expect(node.name).toBe("fallback-name");
  });

  test("displayName takes priority for name", () => {
    const node = nodeFromDict({ displayName: "Display Name", name: "raw-name" });
    expect(node.name).toBe("Display Name");
  });

  test("numExecutors defaults to 1", () => {
    const node = nodeFromDict({ displayName: "agent" });
    expect(node.numExecutors).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// NodeDetailDTO
// ---------------------------------------------------------------------------

describe("nodeDetailFromDict", () => {
  test("SSHLauncher → launcherType 'ssh'", () => {
    const node = nodeDetailFromDict({
      displayName: "ssh-agent",
      launcher: { _class: "hudson.plugins.sshslaves.SSHLauncher" },
    });
    expect(node.launcherType).toBe("ssh");
  });

  test("JNLPLauncher → launcherType 'jnlp'", () => {
    const node = nodeDetailFromDict({
      displayName: "jnlp-agent",
      launcher: { _class: "hudson.slaves.JNLPLauncher" },
    });
    expect(node.launcherType).toBe("jnlp");
  });

  test("Inbound in class → launcherType 'jnlp'", () => {
    const node = nodeDetailFromDict({
      displayName: "inbound-agent",
      launcher: { _class: "jenkins.slaves.StandardInboundAgentConnector" },
    });
    expect(node.launcherType).toBe("jnlp");
  });

  test("missing launcher → launcherType empty string", () => {
    const node = nodeDetailFromDict({ displayName: "no-launcher-agent" });
    expect(node.launcherType).toBe("");
  });

  test("null launcher → launcherType empty string", () => {
    const node = nodeDetailFromDict({ displayName: "null-launcher-agent", launcher: null });
    expect(node.launcherType).toBe("");
  });

  test("remoteDir maps from remoteFS field", () => {
    const node = nodeDetailFromDict({
      displayName: "agent",
      remoteFS: "/home/jenkins",
      launcher: { _class: "SSHLauncher" },
    });
    expect(node.remoteDir).toBe("/home/jenkins");
  });
});

// ---------------------------------------------------------------------------
// CredentialDTO
// ---------------------------------------------------------------------------

describe("credentialFromDict", () => {
  test("basic roundtrip", () => {
    const cred = credentialFromDict({
      id: "my-cred-id",
      displayName: "My Credential",
      typeName: "Username with password",
      scope: "SYSTEM",
      description: "A test credential",
    });
    expect(cred.id).toBe("my-cred-id");
    expect(cred.displayName).toBe("My Credential");
    expect(cred.typeName).toBe("Username with password");
    expect(cred.scope).toBe("SYSTEM");
    expect(cred.description).toBe("A test credential");
  });

  test("scope defaults to 'GLOBAL' when missing", () => {
    const cred = credentialFromDict({ id: "x", displayName: "X", typeName: "T" });
    expect(cred.scope).toBe("GLOBAL");
  });

  test("scope defaults to 'GLOBAL' when empty string", () => {
    const cred = credentialFromDict({ id: "x", displayName: "X", typeName: "T", scope: "" });
    expect(cred.scope).toBe("GLOBAL");
  });

  test("description defaults to empty string when missing", () => {
    const cred = credentialFromDict({ id: "x", displayName: "X", typeName: "T" });
    expect(cred.description).toBe("");
  });
});

// ---------------------------------------------------------------------------
// ControllerDTO
// ---------------------------------------------------------------------------

describe("controllerFromDict", () => {
  test("online = !offline (offline:false → online:true)", () => {
    const ctrl = controllerFromDict({
      name: "ctrl-1",
      url: "https://ctrl.example.com",
      offline: false,
    });
    expect(ctrl.online).toBe(true);
  });

  test("online = !offline (offline:true → online:false)", () => {
    const ctrl = controllerFromDict({
      name: "ctrl-2",
      url: "https://ctrl.example.com",
      offline: true,
    });
    expect(ctrl.online).toBe(false);
  });

  test("online defaults to true when offline missing", () => {
    const ctrl = controllerFromDict({ name: "ctrl-3", url: "https://ctrl.example.com" });
    expect(ctrl.online).toBe(true);
  });

  test("className maps from _class field", () => {
    const ctrl = controllerFromDict({
      name: "ctrl",
      url: "https://ctrl.example.com",
      _class: "com.cloudbees.opscenter.server.CloudBeesServer",
    });
    expect(ctrl.className).toBe("com.cloudbees.opscenter.server.CloudBeesServer");
  });

  test("basic field mapping", () => {
    const ctrl = controllerFromDict({
      name: "my-ctrl",
      url: "https://ctrl.example.com",
      description: "A controller",
      _class: "SomeClass",
      offline: false,
    });
    expect(ctrl.name).toBe("my-ctrl");
    expect(ctrl.url).toBe("https://ctrl.example.com");
    expect(ctrl.description).toBe("A controller");
  });
});

// ---------------------------------------------------------------------------
// UserDTO
// ---------------------------------------------------------------------------

describe("userFromDict", () => {
  test("url maps from absoluteUrl field", () => {
    const user = userFromDict({
      id: "alice",
      fullName: "Alice Example",
      description: "A user",
      absoluteUrl: "https://ci.example.com/user/alice",
    });
    expect(user.url).toBe("https://ci.example.com/user/alice");
  });

  test("fullName maps correctly", () => {
    const user = userFromDict({ id: "bob", fullName: "Bob Builder", absoluteUrl: "" });
    expect(user.fullName).toBe("Bob Builder");
  });

  test("id maps correctly", () => {
    const user = userFromDict({ id: "carol", fullName: "Carol", absoluteUrl: "" });
    expect(user.id).toBe("carol");
  });

  test("description defaults to empty string when missing", () => {
    const user = userFromDict({ id: "x", fullName: "X", absoluteUrl: "" });
    expect(user.description).toBe("");
  });

  test("url defaults to empty string when absoluteUrl missing", () => {
    const user = userFromDict({ id: "x", fullName: "X" });
    expect(user.url).toBe("");
  });
});

// ---------------------------------------------------------------------------
// TeamDTO
// ---------------------------------------------------------------------------

describe("teamFromDict", () => {
  test("basic roundtrip", () => {
    const team = teamFromDict({
      name: "devs",
      description: "Dev team",
      members: ["alice", "bob"],
    });
    expect(team.name).toBe("devs");
    expect(team.description).toBe("Dev team");
    expect(team.members).toEqual(["alice", "bob"]);
  });

  test("members defaults to empty array when missing", () => {
    const team = teamFromDict({ name: "empty", description: "" });
    expect(team.members).toEqual([]);
  });
});
