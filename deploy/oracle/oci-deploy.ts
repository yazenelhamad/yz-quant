/**
 * Create the Oracle Cloud Always Free deployment end to end through the OCI REST API:
 * VCN + subnet + internet gateway + route table + ingress rules (22/80/443), then an Ampere A1
 * (or E2.1.Micro fallback) instance with deploy/oracle/cloud-init.yml attached, then wait until
 * https://<ip>.sslip.io/api/setup answers.
 *
 * Credentials come from the environment only (never pasted into chat):
 *   OCI_TENANCY_OCID, OCI_USER_OCID, OCI_FINGERPRINT, OCI_REGION (e.g. us-ashburn-1),
 *   OCI_PRIVATE_KEY (PEM contents; "\n" escapes accepted) or OCI_PRIVATE_KEY_FILE (path).
 * Options: SETUP_TOKEN (required: the passphrase for the one-time /setup page),
 *   REPO_BRANCH (default: current branch), OCI_COMPARTMENT_OCID (default: tenancy root),
 *   OCI_SHAPE (default VM.Standard.A1.Flex), OCI_SSH_PUBLIC_KEY (optional), INSTANCE_NAME (default yz-quant).
 *
 *   SETUP_TOKEN='my passphrase' npx tsx deploy/oracle/oci-deploy.ts
 */
import { createHash, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;
const need = (k: string): string => { const v = env[k]; if (!v) throw new Error(`missing ${k}`); return v; };
const tenancy = need("OCI_TENANCY_OCID");
const user = need("OCI_USER_OCID");
const fingerprint = need("OCI_FINGERPRINT");
const region = need("OCI_REGION");
const privateKey = env["OCI_PRIVATE_KEY_FILE"] ? readFileSync(env["OCI_PRIVATE_KEY_FILE"], "utf8") : need("OCI_PRIVATE_KEY").replace(/\\n/g, "\n");
const setupToken = need("SETUP_TOKEN");
const compartment = env["OCI_COMPARTMENT_OCID"] ?? tenancy;
const shapePreferred = env["OCI_SHAPE"] ?? "VM.Standard.A1.Flex";
const instanceName = env["INSTANCE_NAME"] ?? "yz-quant";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoBranch = env["REPO_BRANCH"] ?? execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoRoot }).toString().trim();

const keyId = `${tenancy}/${user}/${fingerprint}`;
const log = (m: string) => console.log(`[oci] ${m}`);

/** OCI request signing (draft-cavage HTTP signatures, RSA-SHA256). */
async function oci<T>(service: "iaas" | "identity", method: "GET" | "POST" | "PUT" | "DELETE", pathAndQuery: string, body?: unknown): Promise<T> {
  const host = `${service}.${region}.oraclecloud.com`;
  const date = new Date().toUTCString();
  const headers: Record<string, string> = { date, host };
  let payload: string | undefined;
  const signed = ["(request-target)", "date", "host"];
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(payload));
    headers["x-content-sha256"] = createHash("sha256").update(payload).digest("base64");
    signed.push("content-length", "content-type", "x-content-sha256");
  }
  const signingString = signed.map((h) => (h === "(request-target)" ? `(request-target): ${method.toLowerCase()} ${pathAndQuery}` : `${h}: ${headers[h]}`)).join("\n");
  const signature = createSign("RSA-SHA256").update(signingString).sign(privateKey, "base64");
  headers["authorization"] = `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="${signed.join(" ")}",signature="${signature}"`;
  const res = await fetch(`https://${host}${pathAndQuery}`, { method, headers, body: payload });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathAndQuery} → ${res.status}: ${text.slice(0, 500)}`);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

interface Named { id: string; displayName?: string; lifecycleState?: string }

async function findOrCreate<T extends Named>(list: () => Promise<T[]>, name: string, create: () => Promise<T>): Promise<T> {
  const existing = (await list()).find((x) => x.displayName === name && x.lifecycleState !== "TERMINATED" && x.lifecycleState !== "TERMINATING");
  if (existing) { log(`reusing ${name}`); return existing; }
  log(`creating ${name}`);
  return create();
}

async function waitFor<T extends { lifecycleState?: string }>(get: () => Promise<T>, states: string[], label: string, timeoutMs = 15 * 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const x = await get();
    if (states.includes(x.lifecycleState ?? "")) return x;
    if (Date.now() - start > timeoutMs) throw new Error(`${label} did not reach ${states.join("/")} in time (last: ${x.lifecycleState})`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

async function main(): Promise<void> {
  const c = encodeURIComponent(compartment);
  log(`region ${region}, compartment ${compartment.slice(-12)}, branch ${repoBranch}`);

  // ---- network ----
  const vcn = await findOrCreate<Named & { cidrBlock: string }>(
    () => oci("iaas", "GET", `/20160918/vcns?compartmentId=${c}`),
    `${instanceName}-vcn`,
    () => oci("iaas", "POST", "/20160918/vcns", { compartmentId: compartment, displayName: `${instanceName}-vcn`, cidrBlock: "10.0.0.0/16", dnsLabel: "yzquant" }),
  );
  await waitFor(() => oci<Named>("iaas", "GET", `/20160918/vcns/${vcn.id}`), ["AVAILABLE"], "vcn");
  const igw = await findOrCreate<Named>(
    () => oci("iaas", "GET", `/20160918/internetGateways?compartmentId=${c}&vcnId=${vcn.id}`),
    `${instanceName}-igw`,
    () => oci("iaas", "POST", "/20160918/internetGateways", { compartmentId: compartment, vcnId: vcn.id, displayName: `${instanceName}-igw`, isEnabled: true }),
  );
  const vcnFull = await oci<Named & { defaultRouteTableId: string; defaultSecurityListId: string }>("iaas", "GET", `/20160918/vcns/${vcn.id}`);
  const rt = await oci<Named & { routeRules: { destination: string }[] }>("iaas", "GET", `/20160918/routeTables/${vcnFull.defaultRouteTableId}`);
  if (!rt.routeRules.some((r) => r.destination === "0.0.0.0/0")) {
    log("adding default route to the internet gateway");
    await oci("iaas", "PUT", `/20160918/routeTables/${vcnFull.defaultRouteTableId}`, { routeRules: [...rt.routeRules, { destination: "0.0.0.0/0", destinationType: "CIDR_BLOCK", networkEntityId: igw.id }] });
  }
  const sl = await oci<Named & { ingressSecurityRules: { protocol: string; source: string; tcpOptions?: { destinationPortRange?: { min: number; max: number } } }[]; egressSecurityRules: unknown[] }>("iaas", "GET", `/20160918/securityLists/${vcnFull.defaultSecurityListId}`);
  const wanted = [22, 80, 443];
  const have = new Set(sl.ingressSecurityRules.filter((r) => r.protocol === "6" && r.source === "0.0.0.0/0").map((r) => r.tcpOptions?.destinationPortRange?.min));
  const missing = wanted.filter((p) => !have.has(p));
  if (missing.length) {
    log(`opening ingress ports ${missing.join(", ")}`);
    await oci("iaas", "PUT", `/20160918/securityLists/${vcnFull.defaultSecurityListId}`, {
      ingressSecurityRules: [...sl.ingressSecurityRules, ...missing.map((p) => ({ protocol: "6", source: "0.0.0.0/0", isStateless: false, tcpOptions: { destinationPortRange: { min: p, max: p } } }))],
      egressSecurityRules: sl.egressSecurityRules,
    });
  }
  const subnet = await findOrCreate<Named>(
    () => oci("iaas", "GET", `/20160918/subnets?compartmentId=${c}&vcnId=${vcn.id}`),
    `${instanceName}-public`,
    () => oci("iaas", "POST", "/20160918/subnets", { compartmentId: compartment, vcnId: vcn.id, displayName: `${instanceName}-public`, cidrBlock: "10.0.1.0/24", dnsLabel: "pub", prohibitPublicIpOnVnic: false, routeTableId: vcnFull.defaultRouteTableId, securityListIds: [vcnFull.defaultSecurityListId] }),
  );
  await waitFor(() => oci<Named>("iaas", "GET", `/20160918/subnets/${subnet.id}`), ["AVAILABLE"], "subnet");

  // ---- image + cloud-init ----
  const ads = await oci<{ name: string }[]>("identity", "GET", `/20160918/availabilityDomains?compartmentId=${c}`);
  const cloudInit = readFileSync(path.join(repoRoot, "deploy/oracle/cloud-init.yml"), "utf8")
    .replace('SETUP_TOKEN="CHANGE-ME-choose-a-long-setup-passphrase"', `SETUP_TOKEN=${JSON.stringify(setupToken)}`)
    .replace(/REPO_BRANCH="[^"]*"/, `REPO_BRANCH=${JSON.stringify(repoBranch)}`);
  const userData = Buffer.from(cloudInit).toString("base64");

  // ---- instance (reuse if present) ----
  const existing = (await oci<(Named & { lifecycleState: string })[]>("iaas", "GET", `/20160918/instances?compartmentId=${c}&displayName=${encodeURIComponent(instanceName)}`)).find((i) => !["TERMINATED", "TERMINATING"].includes(i.lifecycleState));
  let instance: Named & { lifecycleState: string; id: string };
  if (existing) {
    log(`instance ${instanceName} already exists (${existing.lifecycleState}); reusing`);
    instance = existing as typeof instance;
  } else {
    const ocpus = Number(env["OCI_OCPUS"] ?? 1);
    const mem = Number(env["OCI_MEMORY_GB"] ?? 6);
    const attempts: { shape: string; shapeConfig?: { ocpus: number; memoryInGBs: number }; imageFilter: string }[] = shapePreferred === "VM.Standard.A1.Flex"
      ? [{ shape: "VM.Standard.A1.Flex", shapeConfig: { ocpus, memoryInGBs: mem }, imageFilter: "aarch64" }, ...(env["OCI_NO_FALLBACK"] ? [] : [{ shape: "VM.Standard.E2.1.Micro", imageFilter: "" }])]
      : [{ shape: shapePreferred, ...(shapePreferred.endsWith(".Flex") ? { shapeConfig: { ocpus, memoryInGBs: mem } } : {}), imageFilter: /A[0-9]\.Flex$/.test(shapePreferred) ? "aarch64" : "" }];
    // Always Free ARM capacity comes and goes; keep trying for OCI_CAPACITY_RETRY_MINUTES (default 0 = one pass).
    const retryUntil = Date.now() + Number(env["OCI_CAPACITY_RETRY_MINUTES"] ?? 0) * 60_000;
    let last: Error | null = null;
    instance = undefined as never;
    let pass = 0;
    outer: for (;;) {
    pass++;
    for (const attempt of attempts) {
      const images = await oci<(Named & { operatingSystem: string; operatingSystemVersion: string; timeCreated: string })[]>("iaas", "GET", `/20160918/images?compartmentId=${c}&operatingSystem=Canonical%20Ubuntu&shape=${encodeURIComponent(attempt.shape)}&sortBy=TIMECREATED&sortOrder=DESC`);
      const candidates = images.filter((i) => /^24\.04|^22\.04/.test(i.operatingSystemVersion) && (attempt.imageFilter ? (i.displayName ?? "").includes(attempt.imageFilter) : !(i.displayName ?? "").includes("aarch64")));
      const image = candidates.find((i) => !(i.displayName ?? "").includes("Minimal")) ?? candidates[0];
      if (!image) { last = new Error(`no Ubuntu image for ${attempt.shape}`); continue; }
      for (const ad of ads) {
        for (let tries = 0; tries < 6; tries++) {
          try {
            log(`launching ${attempt.shape} in ${ad.name} with ${image.displayName}`);
            instance = await oci("iaas", "POST", "/20160918/instances", {
              compartmentId: compartment, availabilityDomain: ad.name, displayName: instanceName, shape: attempt.shape,
              ...(attempt.shapeConfig ? { shapeConfig: attempt.shapeConfig } : {}),
              sourceDetails: { sourceType: "image", imageId: image.id, bootVolumeSizeInGBs: 50 },
              createVnicDetails: { subnetId: subnet.id, assignPublicIp: true },
              metadata: { user_data: userData, ...(env["OCI_SSH_PUBLIC_KEY"] ? { ssh_authorized_keys: env["OCI_SSH_PUBLIC_KEY"] } : {}) },
            });
            break outer;
          } catch (e) {
            last = e as Error;
            const msg = (e as Error).message;
            log(`  ${ad.name}: ${msg.replace(/\s+/g, " ").slice(0, 140)}`);
            if (/TooManyRequests|429/.test(msg)) { const wait = 45_000 * (tries + 1); log(`  rate limited; waiting ${wait / 1000}s`); await new Promise((r) => setTimeout(r, wait)); continue; }
            if (/capacity|LimitExceeded|500|InternalError|NotAuthorizedOrNotFound/i.test(msg)) break; // try the next availability domain
            throw e;
          }
        }
      }
    }
    if (Date.now() >= retryUntil) break;
    log(`no capacity on pass ${pass}; retrying in 150s (until ${new Date(retryUntil).toISOString()})`);
    await new Promise((r) => setTimeout(r, 150_000));
    }
    if (!instance) throw last ?? new Error("could not launch an instance in any availability domain");
  }
  instance = await waitFor(() => oci("iaas", "GET", `/20160918/instances/${instance.id}`), ["RUNNING"], "instance");
  log(`instance ${instance.id.slice(-12)} is RUNNING`);

  // ---- public IP ----
  const attachments = await oci<{ vnicId: string }[]>("iaas", "GET", `/20160918/vnicAttachments?compartmentId=${c}&instanceId=${instance.id}`);
  const vnic = await oci<{ publicIp: string | null }>("iaas", "GET", `/20160918/vnics/${attachments[0]!.vnicId}`);
  if (!vnic.publicIp) throw new Error("instance has no public IP");
  const url = `https://${vnic.publicIp}.sslip.io`;
  log(`public IP ${vnic.publicIp}; waiting for ${url}/api/setup (first build takes 5–10 minutes)`);
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${url}/api/setup`, { signal: AbortSignal.timeout(10_000) });
      if (r.ok) { const j = (await r.json()) as { available: boolean }; log(`setup page is ${j.available ? "OPEN" : "closed (users already exist)"}`); break; }
    } catch { /* not up yet */ }
    if (Date.now() - start > 25 * 60_000) { log("timed out waiting for the setup page; check /var/log/yz-quant-install.log on the VM"); break; }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  console.log(`\nDEPLOYED: open ${url}/setup and enter your setup token.`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
