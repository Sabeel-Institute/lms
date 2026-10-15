/** Rich, realistic (fake) deployment for the user-manual screenshots — emulator. */
import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
const require = createRequire(new URL('../functions/package.json', import.meta.url));
const admin = require('firebase-admin');
import { EMULATOR_PORTS } from './lib/ports.mjs';
import { EMULATOR_PROJECT_ID } from './lib/project.mjs';
import { putLocalObject } from './lib/media-store.mjs';
import { AUDIO_FIXTURE, ensureAudioFixture, ensureSlideVideo } from './lib/media-fixtures.mjs';
import { NEW_STAFF_ACCESS, deriveDurationSec, mediaFromSingleAudio, mediaStorageKey } from '@sabeel/shared';
process.env.FIRESTORE_EMULATOR_HOST=`127.0.0.1:${EMULATOR_PORTS.firestore}`;
process.env.FIREBASE_AUTH_EMULATOR_HOST=`127.0.0.1:${EMULATOR_PORTS.auth}`;
admin.initializeApp({ projectId: EMULATOR_PROJECT_ID });
const auth=admin.auth(), db=admin.firestore();
const now=Date.now(), day=86400000;
const iso=(ms)=>new Date(ms).toISOString().slice(0,10);

// ---- the admin the capture signs in as ----
// PRE-PROVISIONED, so that every seeded change below is attributed to a real
// person. The audit figure and a student's history print the actor's NAME from
// the staff directory, and with a made-up actor id they printed "by admin
// seed-admin" in a manual written for the institute's staff. Created here with
// no provider (the shape `onUserCreate` ignores) and its claims set, the
// capture's dev sign-in LINKS the Google credential to this account — same
// email, same uid — and lands on the admin home without `bootstrapAdmin`.
const ADMIN_EMAIL='faisal.shah@oursabeel.com';
const adminUser=await auth.createUser({ email:ADMIN_EMAIL, displayName:'Faisal Shah' });
await new Promise(r=>setTimeout(r,300));
await auth.setCustomUserClaims(adminUser.uid,{ role:'admin', status:'active' });
await db.collection('staffUsers').doc(adminUser.uid).set({ email:ADMIN_EMAIL, displayName:'Faisal Shah', photoUrl:null, role:'admin', status:'active', createdAt:now-90*day, approvedAt:now-90*day });
const ADMIN=adminUser.uid;

// ---- students ----
const NAMES=['Fatima Ahmed','Bilal Khan','Omar Siddiqui','Ayesha Rahman','Yusuf Ali','Maryam Iqbal','Zainab Hassan','Ibrahim Malik'];
const students=[];
// The last one is DISABLED, so the Students screen has something in its
// "Disabled" section to photograph — an empty collapsible documents nothing.
for (const name of NAMES){
  const email=name.toLowerCase().replace(/ /g,'.')+'@example.com';
  const status = name===NAMES[NAMES.length-1] ? 'disabled' : 'active';
  let u; try { u=await auth.getUserByEmail(email); } catch { u=await auth.createUser({ email, displayName:name }); }
  await new Promise(r=>setTimeout(r,300));
  await auth.setCustomUserClaims(u.uid,{ role:'student', status });
  await db.collection('students').doc(u.uid).set({ email, displayName:name, role:'student', status, createdAt:now-40*day, createdBy:ADMIN });
  students.push({ uid:u.uid, name, email });
}
// Fatima gets a password so she can be shown signing in for the STUDENT screenshots.
await auth.updateUser(students[0].uid,{ password:'HikamStudent1', emailVerified:true });

// ---- cohort + courses ----
const cohortId='guide-cohort';
await db.collection('cohorts').doc(cohortId).set({ name:'Autumn 2026', archived:false, createdAt:now-45*day, createdBy:ADMIN });
// A finished term, so the cohort list has an "Archived" section to show. Its
// course carries effectiveActive:false, which is what the cascade would leave.
await db.collection('cohorts').doc('guide-cohort-past').set({ name:'Spring 2026', archived:true, createdAt:now-220*day, createdBy:ADMIN });
await db.collection('courses').doc('guide-past-course').set({ cohortId:'guide-cohort-past', name:'Seerah Survey', archived:false, effectiveActive:false, archivedAccess:false, managerUids:[], createdAt:now-220*day, createdBy:ADMIN });
const courses={
  hikam:{ id:'guide-hikam', name:'Hikam Foundations' },
  arabic:{ id:'guide-arabic', name:'Arabic I' },
};
for (const c of Object.values(courses))
  await db.collection('courses').doc(c.id).set({ cohortId, name:c.name, archived:false, effectiveActive:true, archivedAccess:false, managerUids:[], createdAt:now-45*day, createdBy:ADMIN });
// enroll all 8 in Hikam; first 4 also in Arabic
for (const s of students) await db.collection('enrollments').doc(`${s.uid}_${courses.hikam.id}`).set({ studentUid:s.uid, courseId:courses.hikam.id, cohortId, active:true, stretches:[{ from:now-40*day, to:null }], enrolledBy:ADMIN });
for (const s of students.slice(0,4)) await db.collection('enrollments').doc(`${s.uid}_${courses.arabic.id}`).set({ studentUid:s.uid, courseId:courses.arabic.id, cohortId, active:true, stretches:[{ from:now-40*day, to:null }], enrolledBy:ADMIN });

// ---- sessions + their recordings: attendance-driven ----
ensureAudioFixture();
const audio=readFileSync(AUDIO_FIXTURE);
const uids=students.map(s=>s.uid);
// Attendance snapshot: the first `present` of `who` are present, the rest EXCUSED
// — excused is the only mark that grants the recording, so a seed that defaulted
// to absent would photograph every student screen empty. `absent` names the
// unexcused, who get nothing and exist here to populate the ledger's own section.
const attend=(present, {excused=[], absent=[], who=uids}={})=>Object.fromEntries(who.map((u,i)=>{
  if (absent.includes(u)) return [u,'absent'];
  if (excused.includes(u)) return [u,'excused'];
  return [u, i<present?'present':'excused'];
}));

async function mkSession(courseId, sid, rid, title, { status='published', dueOffset=7, daysAgo=7, notes='', attendance=null, attention=null, slides=null }={}){
  const date=iso(now-daysAgo*day);
  // Never null: the due date is the day access closes, so a session cannot be
  // without one.
  const dueDate=iso(now+dueOffset*day);
  const hasAudio = status!=='draft';
  const path=mediaStorageKey(rid, 'audio1');
  if (hasAudio) await putLocalObject(path, audio, 'audio/mp4');
  const submitted = attendance ? now-daysAgo*day : null;
  await db.collection('sessions').doc(sid).set({
    courseId, cohortId, date, title, dueDate, notes,
    recordingId: rid, attendance: attendance??{}, attendanceSubmittedAt: submitted,
    notRecorded:false, createdAt:now-daysAgo*day, createdBy:ADMIN, updatedAt:now-daysAgo*day,
  });
  const media = mediaFromSingleAudio({ source:'manual', audioPath:hasAudio?path:null, sizeBytes:audio.length, durationSec:720,
    createdAt:now-daysAgo*day, createdBy:ADMIN }, 'audio1');
  // A class shared its screen: the same part as video too, which students
  // start on — so the manual shows the versions and a "Watch by" card.
  if (slides) {
    const file=`e2e-shots/guide-${rid}.mp4`;
    ensureSlideVideo(file, slides);
    const key=mediaStorageKey(rid, 'video1');
    await putLocalObject(key, readFileSync(file), 'video/mp4');
    media.video1={ ...media.audio1, id:'video1', version:'speaker', kind:'video', storageKey:key,
      contentType:'video/mp4', sizeBytes:statSync(file).size, width:640, height:360 };
  }
  await db.collection('recordings').doc(rid).set({
    sessionId:sid, courseId, cohortId, title, notes, date, status, source:'manual',
    media, defaultVersion:slides?'speaker':'audio', durationSec:deriveDurationSec(media),
    createdAt:now-daysAgo*day, createdBy:ADMIN, updatedAt:now-daysAgo*day,
    ...(status==='published'?{publishedAt:now-daysAgo*day}:{}),
    ...(attention?{attentionReason:attention}:{}),
  });
  // Fan out grants to the EXCUSED (only once published AND attendance taken).
  if (status==='published' && attendance){
    for (const [uid,st] of Object.entries(attendance)){
      if (st==='excused'){
        await db.collection('assignments').doc(`${uid}_${rid}`).set({ studentUid:uid, recordingId:rid, sessionId:sid, courseId, cohortId, dueDate, active:true, assignedAt:submitted, assignedBy:'system' });
      }
    }
  }
  return rid;
}
const H=courses.hikam.id;
// Hikam: attendance taken, most present, the rest excused (and so granted the
// recording). One genuinely unexcused absence, for the ledger's Absent section.
await mkSession(H,'g-s1','g-s1r','Session 1 — Introduction to the Hikam', {dueOffset:-14, daysAgo:21, attendance:attend(6, {absent:[uids[6]]})});
// Fatima (uids[0], the demo student) was excused from sessions 2 and 3, so she
// has real required listening on the student screenshots: s2 missed, s3 due-soon
// (60% listened).
await mkSession(H,'g-s2','g-s2r','Session 2 — Knowledge and Certainty', {dueOffset:-6, daysAgo:14, attendance:attend(4, {excused:[uids[0]]})});
await mkSession(H,'g-s3','g-s3r','Session 3 — Patience in Hardship', {dueOffset:3, daysAgo:5, notes:'Focus on the section about gratitude in hardship — we will discuss it next week.', attendance:attend(5, {excused:[uids[0]]}), slides:'Session 3 — Patience in Hardship'});
await mkSession(H,'g-s4','g-s4r','Session 4 — Sincerity of Intention', {dueOffset:5, daysAgo:2, attendance:attend(6)});
// Session 5: recording published but attendance NOT taken yet — nobody assigned.
await mkSession(H,'g-s5','g-s5r','Session 5 — Reliance and Trust', {status:'published', daysAgo:1, attendance:null});
// Session 6: a Zoom import that needs review, with attendance ALREADY IN — so
// the work queue files it under "Waiting to publish" rather than swallowing it
// into "Attendance not taken", which is the bucket the manual describes and
// which no seeded session used to produce.
await mkSession(H,'g-s6','g-s6r','Session 6 — (import needs review)', {status:'needsAttention', daysAgo:1, attendance:attend(4), attention:'Audio file looks truncated — re-upload before publishing.'});
// Session 7: attendance taken TODAY, recording not added yet.
await db.collection('sessions').doc('g-s7').set({ courseId:H, cohortId, date:iso(now), title:'Session 7 — Today (recording pending)', dueDate:iso(now+7*day), notes:'', recordingId:null, attendance:attend(5), attendanceSubmittedAt:now, notRecorded:false, createdAt:now, createdBy:ADMIN, updatedAt:now });
// Arabic I: two published sessions.
// Only the first four students are enrolled in Arabic, so its snapshot covers
// only them — a mark for someone off the roster would be dropped on submit.
const arabicUids=uids.slice(0,4);
await mkSession(courses.arabic.id,'g-a1','g-a1r','Lesson 1 — The Arabic Alphabet', {dueOffset:-2, daysAgo:9, attendance:attend(3,{who:arabicUids})});
await mkSession(courses.arabic.id,'g-a2','g-a2r','Lesson 2 — Short Vowels', {dueOffset:5, daysAgo:4, attendance:attend(2,{who:arabicUids})});

// ---- completions / progress: a realistic mix over the accountable (absent) set ----
async function complete(uid, rid, listenedFrac=1){
  await db.collection('completions').doc(`${uid}_${rid}`).set({ studentUid:uid, recordingId:rid, courseId:H, completed:true, completedAt:now-2*day, updatedAt:now-2*day });
  const ms = Math.round(720000*listenedFrac);
  await db.collection('listeningProgress').doc(`${uid}_${rid}`).set({ studentUid:uid, recordingId:rid, courseId:H, listenedMs:ms, sittings:{ seed:ms }, sitting:'seed', updatedAt:now-2*day });
}
async function progressOnly(uid, rid, frac){
  const ms = Math.round(720000*frac);
  await db.collection('listeningProgress').doc(`${uid}_${rid}`).set({ studentUid:uid, recordingId:rid, courseId:H, listenedMs:ms, sittings:{ seed:ms }, sitting:'seed', updatedAt:now-3*day });
}
// s1 (g-s1r): 7 is excused, 6 was absent and gets nothing. The excused one caught up.
await complete(uids[7],'g-s1r');
// s2 (g-s2r): excused are 0 and 4..7. Two completed, one part-way, and Fatima
// never started — so she is Missed, past the deadline.
await complete(uids[4],'g-s2r'); await complete(uids[5],'g-s2r');
await progressOnly(uids[6],'g-s2r',0.5);
// s3 (g-s3r): excused are 0 and 5..7. One completed; Fatima is 60% through,
// still ahead of the deadline.
await complete(uids[5],'g-s3r');
await progressOnly(uids[0],'g-s3r',0.6);
// One staff override with a reason (student 6 on s2r).
await db.collection('completionOverrides').doc(`${uids[6]}_g-s2r`).set({ studentUid:uids[6], recordingId:'g-s2r', courseId:H, completed:true, reason:'Attended part of the class in person; caught up on the rest.', overriddenBy:ADMIN, at:now-1*day });

// ---- audit log: realistic recent history ----
const A=(action,detail,extra={})=>({ at:now-(Math.random()*3*day), actorUid:ADMIN, actorRole:'admin', action, courseId:H, targets:extra, ...(detail?{detail}:{}) });
const auditEntries=[
  A('overrideCompletion',{completed:true, reason:'Attended part of the class in person.'},{recordingId:'g-s2r', studentUid:uids[6]}),
  A('submitAttendance',null,{sessionId:'g-s4'}),
  A('setRecordingStatus',{status:'published'},{recordingId:'g-s4r'}),
  A('createSession',null,{sessionId:'g-s4'}),
  A('createStudent',null,{studentUid:uids[7]}),
  A('createEnrollment',null,{studentUid:uids[7], courseId:H}),
];
for (const e of auditEntries) await db.collection('auditLog').add(e);
await db.collection('auditLog').add({ at:now-2*day, actorUid:ADMIN, actorRole:'admin', action:'createCohort', courseId:null, targets:{cohortId} });
// Fatima's own history, as her page reads it out of the log: enrolled, then
// removed from Arabic and brought back — every sentence the History card can
// print, so the student-page figure shows the card with rows in it.
const history=[
  ['createEnrollment', H, null],
  ['createEnrollment', courses.arabic.id, null],
  ['setEnrollmentActive', courses.arabic.id, {active:false}],
  ['setEnrollmentActive', courses.arabic.id, {active:true}],
];
for (const [i,[action,courseId,detail]] of history.entries()){
  await db.collection('auditLog').doc(`guide-history-${i}`).set({
    at:now-(38-i*9)*day, actorUid:ADMIN, actorRole:'admin', action, courseId,
    targets:{studentUid:uids[0], courseId}, ...(detail?{detail}:{}),
  });
}

// ---- assignments ----
// Hikam's assignments, in the states the manual describes: one to do (Fatima
// has an answer saved), handed in by classmates and waiting to be graded, one
// graded; and one already returned to Fatima with a grade and feedback. Due
// AFTER Session 3, so the student's "next up" card stays the recording the
// capture opens by name. The admin manages Hikam by name, which is what puts
// "To grade" on their Today.
await db.collection('courses').doc(H).update({ managerUids:[ADMIN] });
const PDF=Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
/** A photographed page of handwritten work, drawn by a browser so it reads as one in a figure. */
async function workPage(){
  const { chromium } = await import('playwright');
  const b = await chromium.launch();
  const pg = await (await b.newContext({ viewport:{ width:900, height:1150 } })).newPage();
  await pg.setContent(`<html><body style="margin:0;background:#f6f1e4;font-family:'Noto Naskh Arabic',serif">
    <div style="margin:40px;padding:40px;background:#fffdf6;box-shadow:0 2px 8px #0003;height:980px;transform:rotate(-1deg)">
      <div style="font:22px sans-serif;color:#555;margin-bottom:24px">Memorize the first hikma — Bilal Khan</div>
      <div dir="rtl" style="font-size:44px;line-height:2.2;color:#1d2a4a">مِنْ عَلامَةِ الاعْتِمادِ عَلى العَمَلِ<br>نُقْصانُ الرَّجاءِ عِنْدَ وُجودِ الزَّلَلِ</div>
      <div style="font:italic 26px Georgia,serif;color:#1d2a4a;margin-top:40px;line-height:1.6">When I slip, my hope should not fall,<br>because my hope was never in my deeds.</div>
    </div></body></html>`);
  const png = await pg.screenshot({ type:'png' });
  await b.close();
  return png;
}
const attachment = async (key, id, name, contentType, body) => {
  await putLocalObject(key, body, contentType);
  return { id, name, contentType, sizeBytes:body.length, durationSec:null, storageKey:key, addedAt:now-5*day };
};
const due=(d)=>iso(now+d*day);
async function coursework(id, title, { dueOffset, lateOffset, instructions='', files={}, grading={ kind:'points', outOf:10 } }){
  await db.collection('coursework').doc(id).set({
    courseId:H, cohortId, title, instructions, files, dueDate:due(dueOffset), lateUntil:due(lateOffset), grading,
    status:'posted', closedAt:null, postedAt:now-8*day, postedBy:ADMIN, createdAt:now-9*day, createdBy:ADMIN, updatedAt:now-8*day, editedAt:null,
  });
  for (const st of students.slice(0,-1)){ // the last is the disabled account
    await db.collection('submissions').doc(`${st.uid}_${id}`).set({
      studentUid:st.uid, courseworkId:id, courseId:H, cohortId, active:true, dueDate:due(dueOffset), lateUntil:due(lateOffset),
      closedEarly:false, state:'open', attempt:1, handedInAt:null, note:'', files:{}, returned:null, attempts:[],
      notRequired:null, moreTime:null, assignedAt:now-8*day,
    });
  }
}
await coursework('g-cw1','Memorize the first hikma', {
  dueOffset:5, lateOffset:12,
  instructions:'Memorize the first hikma and record yourself reciting it.\n\nمِنْ عَلامَةِ الاعْتِمادِ عَلى العَمَلِ نُقْصانُ الرَّجاءِ عِنْدَ وُجودِ الزَّلَلِ\n\n- Recite slowly, with the vowels as written.\n- One take is fine. A quiet room helps.\n\nIn your answer, explain its meaning in **two or three sentences** of your own.',
  files:{ f1: await attachment('coursework/g-cw1/f1','f1','First hikma, vowelled.pdf','application/pdf',PDF) },
});
await db.collection('drafts').doc(`${uids[0]}_g-cw1`).set({
  studentUid:uids[0], courseworkId:'g-cw1', courseId:H,
  note:'It means that losing hope after a slip shows I was relying on my own deeds.', files:{}, updatedAt:now-day,
});
// Bilal handed in a photographed page; two more handed in; Omar is graded.
const page = await attachment(`work/${uids[1]}/g-cw1/p1`,'p1','Page 1.png','image/png', await workPage());
await db.collection('submissions').doc(`${uids[1]}_g-cw1`).update({ state:'handedIn', handedInAt:now-day, note:'Recited it twice; the page is my written version.', files:{ p1:page } });
await db.collection('submissionEvents').add({ studentUid:uids[1], courseworkId:'g-cw1', courseId:H, kind:'handIn', attempt:1, at:now-day, late:false });
for (const [i,u] of [uids[2], uids[3]].entries()){
  await db.collection('submissions').doc(`${u}_g-cw1`).update({ state:'handedIn', handedInAt:now-(2+i)*day, note:'Recited this morning, twice through without stopping.' });
  await db.collection('submissionEvents').add({ studentUid:u, courseworkId:'g-cw1', courseId:H, kind:'handIn', attempt:1, at:now-(2+i)*day, late:false });
}
await db.collection('grades').doc(`${uids[2]}_g-cw1`).set({ studentUid:uids[2], courseworkId:'g-cw1', courseId:H, grade:{ points:8 }, feedback:'Clear and steady. Give the madd its full two counts.', gradedBy:ADMIN, gradedAt:now-day, withoutHandIn:false });
await coursework('g-cw2','Reflection on the first hikma', {
  dueOffset:-4, lateOffset:3,
  instructions:'Write a short reflection, under 300 words, on the first hikma and one moment in your own week it describes.',
});
await db.collection('submissions').doc(`${uids[0]}_g-cw2`).update({
  state:'returned', handedInAt:now-6*day,
  note:'The first hikma says that when we slip, our hope should not collapse, because hope was never in our deeds.',
  returned:{ grade:{ points:9 }, feedback:'A thoughtful reflection, and your example from work is a good one. Next time, connect it to what the commentary says about hope and fear being two wings.', at:now-2*day, seq:1, retry:false },
});

// ---- staff ----
// A PENDING staff account, so the approvals figure in the manual can show the
// two approve buttons the prose names. Without one the screen photographs as
// "Nobody is waiting" — a true state, and the one state that documents nothing
// about the page it illustrates. Made as a first Google sign-in makes one — an
// account carrying the new-staff claims, and the document `onUserCreate`
// writes beside it — so that approving her works: the admin's help film does.
// A document with no account behind it could be photographed but not approved.
const pendingUser=await auth.createUser({ email:'nadia.karim@oursabeel.com', displayName:'Nadia Karim', emailVerified:true });
await new Promise(r=>setTimeout(r,300));
await auth.setCustomUserClaims(pendingUser.uid,{ ...NEW_STAFF_ACCESS });
await db.collection('staffUsers').doc(pendingUser.uid).set({
  email:'nadia.karim@oursabeel.com', displayName:'Nadia Karim', photoUrl:null,
  ...NEW_STAFF_ACCESS, createdAt:now-2*day,
});
// And a DISABLED one, so the same figure shows the closed Disabled section the
// prose describes, opened the way the students figure opens its own.
await db.collection('staffUsers').doc('guide-disabled').set({
  email:'yusuf.rahman@oursabeel.com', displayName:'Yusuf Rahman', photoUrl:null,
  role:'manager', status:'disabled', createdAt:now-60*day, approvedAt:now-59*day,
});

console.log(JSON.stringify({ studentEmail:students[0].email, studentPw:'HikamStudent1', hikamCourseId:courses.hikam.id, managerUidNeeded:true }, null, 0));
