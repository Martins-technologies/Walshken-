"use client";

import { useState } from "react";
import { ActionForm, Panel, type ResponseData } from "./ui";

type Setup = ResponseData & { setupKey?: string; account?: string; recoveryCodes?: string[] };
const password = { name: "password", label: "Current password", type: "password", autoComplete: "current-password", required: true, max: 160 };
const code = { name: "code", label: "Authenticator code", autoComplete: "one-time-code", required: true, max: 6 };

export function StaffSecurity({ enabled, required }: { enabled: boolean; required: boolean }) {
  const [setup, setSetup] = useState<Setup>();
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);

  if (recoveryCodes.length) return <Panel title="Save your recovery codes"
    note="Each code can be used once. Store them in a safe place before signing in again.">
    <ul className="profile-grid">{recoveryCodes.map((recoveryCode) => <li key={recoveryCode}><code>{recoveryCode}</code></li>)}</ul>
    <a className="btn btn-blue btn-small" href="/staff">Continue to staff sign in</a>
  </Panel>;

  return <Panel title="Two-factor authentication" note={enabled?"Your authenticator is enabled. It stays active until a replacement is verified."
      :required?"Set up your authenticator to access the workspace.":"Use a time-based code from your authenticator app when signing in."}>
    {setup?.setupKey ? <>
      <div className="access-code">
        <strong>Authenticator setup key</strong>
        <code>{setup.setupKey}</code>
        <small>In your authenticator, add a time-based entry for Walshken using {setup.account} and this key.</small>
      </div>
      <ActionForm path="mfa/confirm" fields={[password, code]} submit="Verify and enable"
        onDone={(result: Setup) => { setRecoveryCodes(result.recoveryCodes ?? []); setSetup(undefined); }}/>
    </> : <>
      <ActionForm path="mfa/setup" fields={enabled?[password,{...code,label:"Current authenticator or recovery code",max:24}]:[password]}
        submit={enabled?"Replace authenticator":"Set up authenticator"} onDone={setSetup}/>
      {enabled&&!required&&<ActionForm path="mfa/disable" fields={[password,{...code,label:"Authenticator or recovery code",max:24}]}
        submit="Disable authenticator" onDone={()=>window.location.assign("/staff")}/>}
    </>}
  </Panel>;
}
