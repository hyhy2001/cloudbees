/**
 * getCredentialConfig — XML parsing with fast-xml-parser.
 *
 * Jenkins config.xml for credentials can have root tags with class attributes
 * and may contain XML entities in username/description. Tests here verify the
 * parser handles all these cases without relying on regex.
 */

import { describe, test, expect } from "bun:test";
import { getCredentialConfig } from "../src/plugins/credential/service";
import type { CloudBeesClient } from "../src/core/api/types";

class FakeClient {
  constructor(private xml: string) {}
  async getText(_path: string): Promise<string> { return this.xml; }
}

function asClient(xml: string): CloudBeesClient {
  return new FakeClient(xml) as unknown as CloudBeesClient;
}

describe("getCredentialConfig", () => {
  test("plain username and description", async () => {
    const xml = `<?xml version="1.0"?>
<com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl>
  <username>alice</username>
  <description>deploy key</description>
</com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl>`;
    const r = await getCredentialConfig(asClient(xml), "cred-1");
    expect(r.username).toBe("alice");
    expect(r.description).toBe("deploy key");
  });

  test("root tag with class attribute (Jenkins re-serialised form)", async () => {
    const xml = `<?xml version="1.0"?>
<com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl plugin="credentials@1234">
  <username>bob</username>
  <description>ci bot</description>
</com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl>`;
    const r = await getCredentialConfig(asClient(xml), "cred-2");
    expect(r.username).toBe("bob");
    expect(r.description).toBe("ci bot");
  });

  test("XML entities in values", async () => {
    const xml = `<?xml version="1.0"?>
<com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl>
  <username>user&amp;name</username>
  <description>a &lt;description&gt; with &quot;quotes&quot;</description>
</com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl>`;
    const r = await getCredentialConfig(asClient(xml), "cred-3");
    expect(r.username).toBe("user&name");
    expect(r.description).toBe('a <description> with "quotes"');
  });

  test("missing description returns empty string", async () => {
    const xml = `<?xml version="1.0"?>
<com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl>
  <username>carol</username>
</com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl>`;
    const r = await getCredentialConfig(asClient(xml), "cred-4");
    expect(r.username).toBe("carol");
    expect(r.description).toBe("");
  });

  test("missing username returns empty string", async () => {
    const xml = `<?xml version="1.0"?>
<com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl>
  <description>some desc</description>
</com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl>`;
    const r = await getCredentialConfig(asClient(xml), "cred-5");
    expect(r.username).toBe("");
    expect(r.description).toBe("some desc");
  });

  test("whitespace around values is trimmed", async () => {
    const xml = `<?xml version="1.0"?>
<com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl>
  <username>  dave  </username>
  <description>  spaced  </description>
</com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl>`;
    const r = await getCredentialConfig(asClient(xml), "cred-6");
    expect(r.username).toBe("dave");
    expect(r.description).toBe("spaced");
  });
});
