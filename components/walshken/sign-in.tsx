"use client";
import { useState, type FormEvent } from "react";
import { Brand, Icon } from "./brand";
import { api } from "./ui";
import "./staff-sign-in.css";

export function SignIn({ready,initial}:{ready:boolean;initial:boolean}){
  const [mode,setMode]=useState(initial?"bootstrap":"login");
  const [notice,setNotice]=useState("");
  const [error,setError]=useState(""),[pending,setPending]=useState(false);
  const [showPassword,setShowPassword]=useState(false);
  const recovering=mode==="recover";
  const activate=mode==="activate";
  const bootstrap=mode==="bootstrap";
  function choose(next: string) {
    setMode(next);
    setError("");
    setNotice("");
    setShowPassword(false);
  }
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(pending)return;setPending(true);setError("");
    try{
      const result = await api(`session/${mode}`,Object.fromEntries(new FormData(event.currentTarget)));
      if (result.signInRequired) {
        setMode("login");
        setShowPassword(false);
        setNotice("Password saved. Sign in to continue.");
        setPending(false);
        return;
      }
      window.location.assign(window.location.pathname + window.location.search);
    }catch(e){setError(e instanceof Error?e.message:"Try again.");setPending(false);}
  }
  return <main className="auth-page staff-sign-in">
    <div className="auth-side"><Brand/><div className="auth-story">
      <p className="auth-story-title">Walshken staff portal</p><p>Access your team, assignments and schedule in one secure workspace.</p>
    </div><a href="/" className="text-link"><Icon name="left" size={16}/> Corporate website</a></div>
    <div className="auth-main"><div className="auth-shell">
      <span className="icon-tile"><Icon name="lock" size={23}/></span>
      <h1>{bootstrap?"Set up Walshken":recovering?"Reset your password":activate?"Activate access or reset password":"Staff sign in"}</h1>
      <p>{!ready?"Staff access opens when the Walshken database is connected.":bootstrap?"Create the first administrator using the configured work email and setup code.":recovering
        ?"Use one saved recovery code to choose a new password. You’ll still need an authenticator code or a different recovery code to sign in."
        :activate?"Use the one-time code from your administrator to set your password.":"Sign in with your Walshken work email."}</p>
      {ready&&<form className="auth-form" onSubmit={submit} key={mode} aria-busy={pending||undefined}>
        {mode==="bootstrap"&&<label>Full name<input name="name" required autoComplete="name" maxLength={100}/></label>}
        <label>Work email<input name="email" type="email" required autoComplete="username" maxLength={254} autoCapitalize="none" spellCheck={false}/></label>
        {mode!=="login"&&<label>{bootstrap?"Setup code":recovering?"Saved recovery code":"Activation or reset code"}<input name="code" type="password" required maxLength={180} autoComplete="off"/></label>}
        <div className="auth-password"><label htmlFor="staff-password">Password<input id="staff-password" name="password" type={showPassword?"text":"password"} required minLength={mode==="login"?undefined:12} maxLength={160}
          autoComplete={mode==="login"?"current-password":"new-password"} placeholder={mode==="login"?undefined:"At least 12 characters"}/></label>
          <button type="button" className="auth-reveal" aria-controls="staff-password" aria-label={showPassword?"Hide password":"Show password"} onClick={()=>setShowPassword(visible=>!visible)}>{showPassword?"Hide":"Show"}</button></div>
        {mode==="login"&&<label>Authenticator or recovery code <small>(if set up)</small><input name="mfaCode" autoComplete="one-time-code" maxLength={24} autoCapitalize="none" spellCheck={false}/></label>}
        {notice&&<p className="form-success" role="status"><Icon name="success" size={16}/>{notice}</p>}
        {error&&<p className="form-error" role="alert"><Icon name="alert" size={16}/>{error}</p>}
        <button className="btn btn-blue" disabled={pending}>{pending?"Working…":bootstrap?"Create administrator":mode!=="login"?"Save password":"Sign in"}<Icon name="right" size={16}/></button>
      </form>}
      {ready&&!initial&&<div className="auth-options">
        {mode==="login"?<>
          <button type="button" className="text-link auth-toggle" onClick={()=>choose("activate")}>I have an activation or admin reset code</button>
          <button type="button" className="text-link auth-toggle" onClick={()=>choose("recover")}>Reset password with a recovery code</button>
        </>:<button type="button" className="text-link auth-toggle" onClick={()=>choose("login")}>Back to sign in</button>}
      </div>}
    </div></div>
  </main>;
}
