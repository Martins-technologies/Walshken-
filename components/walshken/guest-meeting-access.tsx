"use client";

import "@livekit/components-styles";
import {
  ConnectionStateToast, ControlBar, GridLayout, LiveKitRoom, ParticipantTile, PreJoin, RoomAudioRenderer,
  StartAudio, useLocalParticipantPermissions, useRoomContext, useTracks,
} from "@livekit/components-react";
import {TrackSource} from "@livekit/protocol";
import {RoomEvent, Track} from "livekit-client";
import {useCallback, useEffect, useRef, useState} from "react";
import {Icon} from "./brand";
import styles from "./guest-meeting-access.module.css";

type InvitationStatus = "Invited" | "Accepted" | "Declined" | "Cancelled" | "Ended";
type GuestDetails = {
  title: string; organizer: string; description: string; instructions: string;
  startsAt: string; endsAt: string; timeZone: string; mode: string;
  status: InvitationStatus; guestName: string; canJoin: boolean; waiting: boolean; waitingRoom: boolean;
  joinStartsAt: string; locked: boolean; canPublish: boolean; recordingEnabled: boolean; recordingRequired: boolean;
  recordingStatus: "Starting" | "Active" | "Stopping" | null; recordingBlocked: boolean;
  recordingConsent: number | null; retentionDays: number; roster: {name: string}[];
};
type Access = {token: string; serverUrl: string; mode: string; endsAt: string; canPublish: boolean};
type DeviceOptions = {audioEnabled: boolean; videoEnabled: boolean; audioDeviceId?: string; videoDeviceId?: string};
type Result = Partial<GuestDetails & Access> & {error?: string};
type GuestAction = "exchange" | "status" | "accept" | "decline" | "join" | "consent";
const storageKey = "walshken-meeting-guest-id";
const fragment = /^#([0-9a-f-]{36})\.([a-zA-Z0-9_-]{43})$/;
const mutedDevices: DeviceOptions = {audioEnabled: false, videoEnabled: false};

class GuestRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function callGuest(guest: string, action: GuestAction, fields: Record<string, unknown> = {}) {
  const response = await fetch(`/api/meeting-guest/${action}`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    credentials: "same-origin",
    body: JSON.stringify({guest, ...fields}),
    cache: "no-store",
  });
  const data = await response.json().catch(() => null) as Result | null;
  if (!response.ok || !data) throw new GuestRequestError(data?.error || "Meeting access is temporarily unavailable.", response.status);
  return data;
}

function dateLine(value: string, zone: string) {
  return new Intl.DateTimeFormat("en", {
    weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    timeZone: zone, timeZoneName: "short",
  }).format(new Date(value));
}

function RecordingNotice({status}: {status: NonNullable<GuestDetails["recordingStatus"]>}) {
  const label = status === "Starting" ? "Recording is starting" : status === "Stopping" ? "Recording is stopping" : "This meeting is being recorded";
  return <div className={styles.recording} role="status"><span aria-hidden="true"/>{label}</div>;
}

function GuestConference({mode, onError}: {mode: string; onError: (message: string) => void}) {
  const room = useRoomContext();
  const [recording, setRecording] = useState(room.isRecording);
  const tracks = useTracks([{source: Track.Source.Camera, withPlaceholder: true}, {source: Track.Source.ScreenShare, withPlaceholder: false}]);
  const permissions = useLocalParticipantPermissions();
  const permits = (source: TrackSource) => !!permissions?.canPublish &&
    (!permissions.canPublishSources.length || permissions.canPublishSources.includes(source));
  useEffect(() => {
    setRecording(room.isRecording);
    room.on(RoomEvent.RecordingStatusChanged, setRecording);
    return () => {room.off(RoomEvent.RecordingStatusChanged, setRecording);};
  }, [room]);
  return <>
    {recording && <RecordingNotice status="Active"/>}
    <GridLayout tracks={tracks} className={styles.grid}><ParticipantTile/></GridLayout>
    <RoomAudioRenderer/>
    <StartAudio label="Enable meeting audio" className={styles.enableAudio}/>
    <ControlBar controls={{
      microphone: permits(TrackSource.MICROPHONE),
      camera: mode === "Video" && permits(TrackSource.CAMERA),
      screenShare: permits(TrackSource.SCREEN_SHARE), chat: false, settings: false, leave: true,
    }} onDeviceError={({error}) => onError(error.message)} saveUserChoices={false}/>
    <ConnectionStateToast/>
  </>;
}

function MeetingFacts({meeting,calendarPending,onCalendar}: {meeting: GuestDetails;calendarPending:boolean;onCalendar:()=>void}) {
  return <aside className={styles.facts} aria-labelledby="meeting-schedule">
    <h2 id="meeting-schedule"><Icon name="calendar" size={20}/>Meeting schedule</h2>
    <dl className={styles.times}>
      <div><dt>Starts</dt><dd><time dateTime={meeting.startsAt}>{dateLine(meeting.startsAt, meeting.timeZone)}</time></dd></div>
      <div><dt>Ends</dt><dd><time dateTime={meeting.endsAt}>{dateLine(meeting.endsAt, meeting.timeZone)}</time></dd></div>
      <div><dt>Time zone</dt><dd>{meeting.timeZone.replaceAll("_", " ")}</dd></div>
    </dl>
    {["Invited","Accepted"].includes(meeting.status)&&<div className={styles.actions}>
      <button type="button" onClick={onCalendar} disabled={calendarPending}>
        <Icon name="download" size={16}/>{calendarPending?"Preparing calendar file…":"Download calendar file"}
      </button>
    </div>}
    {!!meeting.roster.length && <details className={styles.roster}>
      <summary><Icon name="users" size={17}/>Meeting participants</summary>
      <ul>{meeting.roster.map(({name}, index) => <li key={`${name}-${index}`}>{name}</li>)}</ul>
    </details>}
  </aside>;
}

export function GuestMeetingAccess() {
  const [guest, setGuest] = useState("");
  const [meeting, setMeeting] = useState<GuestDetails | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<GuestAction | null>(null);
  const [calendarPending,setCalendarPending] = useState(false);
  const [prejoin, setPrejoin] = useState(false);
  const [access, setAccess] = useState<Access | null>(null);
  const [connected, setConnected] = useState(false);
  const [devices, setDevices] = useState(mutedDevices);
  const [initializing, setInitializing] = useState(true);
  const invitation = useRef<{guest: string; token?: string} | null>(null);
  const readLink = useRef(false);
  const actionPending = useRef(false);
  const autoJoin = useRef(false);
  const openInvitation = useCallback(async () => {
    const link = invitation.current;
    if (!link) return setInitializing(false);
    setInitializing(true);
    setError("");
    try {
      const data = await callGuest(link.guest, link.token ? "exchange" : "status", link.token ? {token: link.token} : {});
      const details = data as GuestDetails;
      setMeeting(details);
      setName(details.guestName);
      invitation.current = {guest: link.guest};
      try {sessionStorage.setItem(storageKey, link.guest);} catch {/* The current tab remains available. */}
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Could not open this invitation.");
    } finally {
      setInitializing(false);
    }
  }, []);

  useEffect(() => {
    if (readLink.current) return;
    readLink.current = true;
    const params = window.location.hash.match(fragment);
    const storedGuest = () => {try {return sessionStorage.getItem(storageKey) || "";} catch {return "";}};
    const target = params?.[1] || storedGuest();
    if (params) window.history.replaceState(null, "", window.location.pathname + window.location.search);
    if (!target) {
      setInitializing(false);
      return;
    }
    invitation.current = {guest: target, token: params?.[2]};
    setGuest(target);
    void openInvitation();
  }, [openInvitation]);

  const act = useCallback(async (action: GuestAction, fields: Record<string, unknown> = {}) => {
    if (!guest || actionPending.current) return;
    actionPending.current = true;
    setBusy(action);
    setError("");
    setNotice("");
    try {
      const result = await callGuest(guest, action, fields);
      if (result.title) setMeeting(result as GuestDetails);
      if (result.token && result.serverUrl) {
        setAccess(result as Access);
        setPrejoin(false);
        autoJoin.current = false;
      } else if (action === "join" && result.waiting) {
        setMeeting(previous => previous ? {...previous, waiting: true} : previous);
        setPrejoin(false);
        autoJoin.current = true;
      } else if (action === "decline") {
        setAccess(null);
        autoJoin.current = false;
      }
    } catch (problem) {
      autoJoin.current = false;
      setError(problem instanceof Error ? problem.message : "Could not complete this action.");
    } finally {
      actionPending.current = false;
      setBusy(null);
    }
  }, [guest]);
  const status = meeting?.status;
  const waiting = !!meeting?.waiting;
  const inRoom = !!access;
  const connectionActive = inRoom && connected;

  useEffect(() => {
    if (!guest || !status || !["Invited", "Accepted"].includes(status)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (actionPending.current) return;
        const details = await callGuest(guest, "status") as GuestDetails;
        if (cancelled || actionPending.current) return;
        setMeeting(details);
        if (details.status !== "Accepted" && details.status !== "Invited") {
          autoJoin.current = false;
          setAccess(null);
        } else if (autoJoin.current && details.status === "Accepted" && !details.waiting && details.canJoin) {
          autoJoin.current = false;
          void act("join");
        }
      } catch (problem) {
        if (cancelled) return;
        if (problem instanceof GuestRequestError && [401, 403, 404].includes(problem.status)) {
          setAccess(null);
          setMeeting(null);
          setError(problem.message);
          autoJoin.current = false;
          cancelled = true;
        }
      } finally {
        if (!cancelled) timer = setTimeout(poll, waiting ? 3000 : inRoom ? 8000 : 12000);
      }
    };
    timer = setTimeout(poll, waiting ? 3000 : inRoom ? 8000 : 12000);
    return () => {cancelled = true; clearTimeout(timer);};
  }, [guest, status, waiting, inRoom, act]);

  const deviceError = useCallback(() => {
    setNotice("The browser could not open one of your devices. Check browser permissions or join muted.");
  }, []);
  const canSubmitDevices = useCallback(() => !busy, [busy]);
  const join = (selection: DeviceOptions) => {
    setDevices(selection);
    void act("join");
  };
  async function downloadCalendar() {
    if(!guest||calendarPending)return;
    setCalendarPending(true);setError("");
    try {
      const response=await fetch("/api/meeting-guest/calendar",{method:"POST",credentials:"same-origin",cache:"no-store",
        headers:{"Content-Type":"application/json"},body:JSON.stringify({guest})});
      if(!response.ok||!response.headers.get("Content-Type")?.startsWith("text/calendar"))throw new Error("The meeting calendar file is unavailable.");
      const url=URL.createObjectURL(await response.blob());
      const link=document.createElement("a");
      link.href=url;link.download="walshken-meeting.ics";link.click();
      window.setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(reason){setError(reason instanceof Error?reason.message:"The meeting calendar file could not be downloaded.");}
    finally{setCalendarPending(false);}
  }
  const open = !!meeting?.canJoin;
  const checkingDevices = prejoin && !!meeting?.canPublish;
  const actionTitle = !meeting ? "" : meeting.status === "Invited" ? "Respond to the invitation"
    : meeting.status === "Accepted" ? connectionActive ? "In the meeting" : access ? "Connecting to the meeting" : waiting ? "Waiting for the host" : "Join the meeting"
      : meeting.status === "Declined" ? "Invitation declined" : meeting.status === "Cancelled" ? "Meeting cancelled" : "Meeting ended";

  return <main className={styles.page}>
    <div className={`${styles.shell} ${inRoom ? styles.shellWide : ""}`}>
      <header className={styles.masthead}>
        <div className={styles.brand}><img src="/favicon.svg" width="34" height="34" alt=""/>Walshken<span>.</span></div>
        <span className={styles.secure}><Icon name="lock" size={15}/>Private meeting</span>
      </header>
      {!meeting ? <section className={`${styles.card} ${styles.empty}`} aria-labelledby="access-title">
        <span className={styles.featureIcon}><Icon name="video" size={28}/></span>
        <h1 id="access-title">Meeting access</h1>
        {initializing ? <p role="status">Opening your invitation…</p> : <>
          {error ? <p className={styles.error} role="alert"><Icon name="alert" size={18}/>{error}</p>
            : <p>Open the secure link from your Walshken invitation to view the meeting details and respond.</p>}
          {guest && error && <div className={styles.actions}><button type="button" onClick={() => void openInvitation()}>Try again</button></div>}
        </>}
      </section> : <article className={styles.card} aria-labelledby="meeting-title">
        <header className={styles.heading}>
          <span className={styles.featureIcon}><Icon name={meeting.mode === "Video" ? "video" : "phone"} size={25}/></span>
          <div>
            <span className={styles.typeLine}>{meeting.mode} meeting</span>
            <h1 id="meeting-title">{meeting.title}</h1>
            <p>Hosted by {meeting.organizer}</p>
          </div>
        </header>
        <div className={styles.layout}>
          <div className={styles.mainColumn}>
            {meeting.description && <p className={styles.copy}>{meeting.description}</p>}
            {!!meeting.instructions && <section className={styles.instructions} aria-labelledby="meeting-instructions">
              <h2 id="meeting-instructions"><Icon name="list" size={18}/>Meeting instructions</h2><p>{meeting.instructions}</p>
            </section>}
            {meeting.recordingStatus && !access && <RecordingNotice status={meeting.recordingStatus}/>}
            {error && <p className={styles.error} role="alert"><Icon name="alert" size={18}/>{error}</p>}
            {notice && <p className={styles.notice} role="status">{notice}</p>}
            <section className={styles.joinPanel} aria-labelledby="meeting-actions">
              <header className={styles.actionHeading}>
                <h2 id="meeting-actions">{actionTitle}</h2>
                <span className={styles.statusPill} data-status={meeting.status}>
                  {connectionActive ? "Connected" : meeting.status === "Invited" ? "Response needed" : meeting.status}
                </span>
              </header>
              {meeting.status === "Invited" && <form method="post" className={styles.form} onSubmit={event => {event.preventDefault(); void act("accept", {name});}}>
                <label htmlFor="meeting-guest-name">Your display name</label>
                <input id="meeting-guest-name" value={name} onChange={event => setName(event.target.value)} required maxLength={100} autoComplete="name"/>
                <div className={styles.actions}>
                  <button className={styles.primary} disabled={!!busy} type="submit">{busy === "accept" ? "Accepting…" : "Accept invitation"}</button>
                  <button type="button" disabled={!!busy} onClick={() => void act("decline")}>Decline invitation</button>
                </div>
              </form>}
              {meeting.status === "Accepted" && <>
                {!access && <div className={styles.joinControls}>
                  {waiting && <p role="status">The host has been notified. Keep this tab open to see when you can join.</p>}
                  {!waiting && !open && <p role="status">{meeting.locked ? "The host has locked the meeting." : meeting.recordingBlocked
                    ? meeting.recordingConsent === 0 ? "You can join after recording stops." : "Give recording consent below or wait until recording stops."
                    : <>Joining opens <time dateTime={meeting.joinStartsAt}>{dateLine(meeting.joinStartsAt, meeting.timeZone)}</time>.</>}</p>}
                  {!waiting && open && checkingDevices && <div className={styles.prejoin} data-lk-theme="default" data-audio-only={meeting.mode !== "Video"}>
                    <PreJoin defaults={{username: meeting.guestName, audioEnabled: false, videoEnabled: false}}
                      persistUserChoices={false} joinLabel={meeting.waitingRoom ? "Continue to meeting" : "Join meeting"} onValidate={canSubmitDevices}
                      onError={deviceError} onSubmit={join}/>
                  </div>}
                  <div className={styles.actions}>
                    {!waiting && open && !checkingDevices && <>
                      {meeting.canPublish && <button type="button" className={styles.primary} disabled={!!busy} onClick={() => setPrejoin(true)}>Check devices</button>}
                      <button type="button" className={meeting.canPublish ? undefined : styles.primary} disabled={!!busy} onClick={() => join(mutedDevices)}>
                        {busy === "join" ? "Connecting…" : meeting.waitingRoom ? "Request entry" : meeting.canPublish ? "Join muted" : "Join and listen"}
                      </button>
                    </>}
                    {!waiting && open && checkingDevices && <button type="button" disabled={!!busy} onClick={() => setPrejoin(false)}>Back</button>}
                    <button type="button" disabled={!!busy} onClick={() => void act("decline")}>Decline invitation</button>
                  </div>
                </div>}
                {access && <div data-lk-theme="default" className={styles.room}>
                  <LiveKitRoom serverUrl={access.serverUrl} token={access.token}
                    audio={access.canPublish && devices.audioEnabled ? {deviceId: devices.audioDeviceId} : false}
                    video={access.canPublish && access.mode === "Video" && devices.videoEnabled ? {deviceId: devices.videoDeviceId} : false}
                    options={{adaptiveStream: true, dynacast: true}} onError={problem => setError(problem.message)}
                    onConnected={() => setConnected(true)} onDisconnected={() => {setConnected(false); setAccess(null);}}>
                    <GuestConference mode={access.mode} onError={setError}/>
                  </LiveKitRoom>
                </div>}
              </>}
              {meeting.status === "Declined" && <p role="status">The organizer has been notified that you declined.</p>}
              {(meeting.status === "Cancelled" || meeting.status === "Ended") && <p role="status">You can no longer join this meeting.</p>}
            </section>
            {meeting.status === "Accepted" && (meeting.recordingEnabled || meeting.recordingStatus) && <section className={styles.instructions} aria-labelledby="recording-consent">
              <h2 id="recording-consent"><Icon name="shield" size={18}/>Recording consent</h2>
              <p>Your voice, video and shared screen can be recorded. Recordings are private and retained for {meeting.retentionDays} days.
                {meeting.recordingRequired ? " Participants must consent before recording." : ""}</p>
              <div className={styles.actions}>
                <button type="button" disabled={!!busy || !meeting.recordingEnabled || meeting.recordingConsent === 1} onClick={() => void act("consent", {consent: "1"})}>
                  {meeting.recordingConsent === 1 ? "Consent saved" : "Give consent"}
                </button>
                <button type="button" disabled={!!busy || meeting.recordingConsent === 0} onClick={() => void act("consent", {consent: "0"})}>
                  {meeting.recordingConsent === 0 ? "Recording declined" : meeting.recordingConsent === 1 ? "Withdraw consent" : "Decline recording"}
                </button>
              </div>
            </section>}
          </div>
          <MeetingFacts meeting={meeting} calendarPending={calendarPending} onCalendar={()=>void downloadCalendar()}/>
        </div>
      </article>}
    </div>
  </main>;
}
