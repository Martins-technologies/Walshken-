"use client";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Brand, Icon } from "./brand";
import "./client-portal.css";

type Mode = "login" | "register" | "reset" | "verify" | "reset-code";
export async function clientRequest<T>(path:string, data?:Record<string,unknown>, signal?:AbortSignal):Promise<T> {
  const res = await fetch(path,{cache:"no-store",signal,...(data?{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(data)}:{})});
  const result = await res.json().catch(()=>null);
  if(!res.ok||!result)throw Object.assign(new Error(result?.error||"The request could not be completed."),{status:res.status});
  return result as T;
}

const titles:Record<Mode,string>={login:"Sign in to your portal",register:"Create your client account",reset:"Reset your password",verify:"Verify your email address","reset-code":"Set a new password"};
type AccessReply={challengeId?:string;message?:string;verified?:boolean;resendAfter?:number};
export function ClientAccess({mode:initial}:{mode:Mode}){
  const [mode,setMode]=useState(initial),[challenge,setChallenge]=useState(""),[email,setEmail]=useState(""),[busy,setBusy]=useState(false);
  const [notice,setNotice]=useState(""),[error,setError]=useState(""),[visible,setVisible]=useState(false),[mfaRequired,setMfaRequired]=useState(false);
  const [ready,setReady]=useState(false);
  useEffect(()=>setReady(true),[]);
  const challengeForm=mode==="verify"||mode==="reset-code";
  async function handle(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!ready||busy)return;
    setBusy(true);setError("");setNotice("");
    const form=Object.fromEntries(new FormData(event.currentTarget));
    try{
      const endpoint={login:"sign-in",register:"sign-up",reset:"password-reset",verify:"verify","reset-code":"password-reset-confirm"}[mode];
      const reply=await clientRequest<AccessReply>("/api/customer/"+endpoint,{...form,...(challengeForm?{challengeId:challenge}:{})});
      if(mode==="login"||mode==="verify"){window.location.assign("/customer");return;}
      if(mode==="reset-code"){setMode("login");setVisible(false);setNotice(reply.message||"Password updated. Sign in with your new password.");return;}
      setChallenge(reply.challengeId??"");
      setEmail(String(form.email??""));
      setVisible(false);
      setMode(mode==="reset"?"reset-code":"verify");
      setNotice(reply.message??"Check your email for the one-time code.");
    }catch(e){if(mode==="login"&&(e as {status?:number}).status===428)setMfaRequired(true);setError((e as Error).message);}
    finally{setBusy(false);}
  }
  async function resend(){
    if(!ready||busy)return;
    setError("");setNotice("");setBusy(true);
    try{
      const response=await clientRequest<AccessReply>("/api/customer/resend",{challengeId:challenge});
      if(response.challengeId)setChallenge(response.challengeId);
      setNotice(response.message??"If eligible, a new code will be delivered.");
    }catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  }
  return <main className="client-auth">
    <aside className="client-auth-brand"><Brand/><div><p className="client-eyebrow">WALSHKEN IMMIGRATION</p><p className="client-auth-statement">Your case, in one secure place.</p><p>Follow your application, submit documents and stay connected with your representative.</p></div>
      <Link href="/" className="client-auth-back"><Icon name="left" size={16}/> Corporate website</Link>
    </aside>
    <div className="client-auth-main"><section className="client-auth-panel" aria-labelledby="client-access-heading">
      <span className="client-symbol"><Icon name="lock" size={21}/></span>
      <h1 id="client-access-heading">{titles[mode]}</h1>
      <p>{challengeForm?"Use the code sent to your email.":mode==="reset"?"Enter the email address associated with your account.":mode==="register"?"Use an email address you can access for verification.":"Access your cases, documents and updates."}</p>
      <form method="post" className="client-form" key={mode} onSubmit={handle} aria-busy={busy}>
        {mode==="register"&&<label>Full legal name<input name="name" required maxLength={100} autoComplete="name"/></label>}
        {!challengeForm&&<label>Email address<input type="email" name="email" autoComplete="username" autoCapitalize="none" spellCheck={false} defaultValue={email} required maxLength={254}/></label>}
        {challengeForm&&<label>One-time code<input name="code" inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6}/></label>}
        {["login","register","reset-code"].includes(mode)&&<label>Password<span className="client-password"><input name="password" type={visible?"text":"password"} minLength={mode==="login"?undefined:12} maxLength={160} autoComplete={mode==="login"?"current-password":"new-password"} required/><button type="button" onClick={()=>setVisible(!visible)}>{visible?"Hide":"Show"}</button></span></label>}
        {mode==="login"&&mfaRequired&&<label>Authenticator or recovery code<input name="mfaCode" autoComplete="one-time-code" maxLength={24} autoFocus required/></label>}
        {(mode==="register"||mode==="reset-code")&&<label>Confirm password<input type="password" name="confirmPassword" autoComplete="new-password" minLength={12} maxLength={160} required/></label>}
        {error&&<p className="client-alert" role="alert">{error}</p>}
        {notice&&<p className="client-success" role="status">{notice}</p>}
        <button className="btn btn-blue client-auth-submit" type="submit" disabled={!ready||busy}>{busy?"Please wait…":{login:"Sign in",register:"Send verification code",reset:"Send reset code",verify:"Verify and sign in","reset-code":"Save new password"}[mode]}<Icon name="right" size={17}/></button>
      </form>
      <div className="client-auth-links">
       {challengeForm&&<button type="button" className="client-text" disabled={busy||!challenge} onClick={()=>void resend()}>Send another code</button>}
       {mode==="login"?<><Link href="/customer/sign-up">Create an account</Link><Link href="/customer/reset">Forgot password?</Link></>:<Link href="/customer/sign-in">Back to sign in</Link>}
      </div>
    </section></div>
  </main>;
}
