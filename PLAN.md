# Download Organizer — 구현 계획 (v1)

> 작성일: 2026-08-31 — 최초 Implementation Plan 스냅샷. 이후 논의로 계획이 갱신되면 이 파일은 별도로 보존되는 "첫 번째 버전" 기록입니다.

## Context (배경)

현재 저장소는 `README.md`만 있는 완전한 신규(greenfield) 프로젝트입니다. 목표는 Windows 환경을 우선 지원하는 Chrome Extension으로, ChatGPT·Gemini(추후 다른 AI 서비스로 확장) 등에서 생성한 이미지/영상을 다운로드할 때 "AI Session"이 켜져 있는 동안만 자동으로 파일명을 재작성하고 `Project/Sequence/Shot/Bucket` 계층 구조에 따라 사용자가 지정한 Windows 경로(다른 드라이브 문자나 NAS/UNC 경로 포함) 아래에 정확히 라우팅하는 것입니다. Session이 꺼져 있으면 Chrome의 일반 다운로드 동작은 전혀 변경되지 않아야 합니다.

**개발 환경 관련 중요 전제 (사용자 확인):** 개발은 macOS(MacBook)에서 진행하고, 최종 사용/배포 대상은 Windows입니다. 따라서 이 계획 전체는 "Mac에서 개발하고, Windows에서 검증·배포한다"는 제약을 전제로 설계했습니다 (자세한 내용은 맨 뒤 부록 참고).

계획을 작성하기 전에, 전체 아키텍처를 좌우하는 핵심 Chrome API 제약을 추측이 아니라 공식 문서로 확인했습니다:

- `chrome.downloads.onDeterminingFilename` / `chrome.downloads.download()`: *"filename... 사용자의 기본 Downloads 디렉터리를 기준으로 한 상대 경로만 허용하며, 절대 경로·빈 경로·'..'가 포함된 경로는 무시된다."* ([Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/downloads))
- MV3 익스텐션 컨텍스트 안에서 `showDirectoryPicker()` / File System Access API는 공식적으로 불안정하다고 문서화되어 있습니다(팝업에서 호출 실패, 권한이 열린 탭에만 종속, 영구 권한 보장 없음) — 임의 드라이브/NAS 접근에는 사용할 수 없습니다. ([Chromium 이슈 트래커](https://issues.chromium.org/issues/40240444), [Chrome for Developers](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api))
- Native Messaging은 Chrome Extension이 임의의 로컬 Windows 프로세스와 통신할 수 있는 공식 지원 방법으로, HKCU/HKLM 레지스트리 키가 `allowed_origins`를 포함한 manifest JSON을 가리키는 방식으로 등록됩니다. 메시지 크기 제한: extension→host 최대 4GB, host→extension 최대 1MB. ([Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging))

**결론:** 제품의 핵심 요구사항(§3 — 임의의 Windows 루트 경로, D:\, NAS/UNC)은 Extension만으로는 근본적으로 불가능합니다. 따라서 Windows Local Agent는 "MVP 이후에 필요하면 추가"하는 선택 사항이 아니라 **MVP부터 필수**입니다. 이는 사용자가 원래 구상했던 MVP 범위(§B에서 상세 설명)를 일부 수정합니다.

---

## A. 제품 요약 (Product Summary)

Download Organizer는 Chrome(Windows) 확장 프로그램으로, "AI Session" 토글이 켜져 있을 때만 허용된 AI 생성 사이트(ChatGPT, Gemini, 이후 Runway/Veo/Sora 등으로 확장 가능)에서의 이미지/영상 다운로드를 가로채, 설정된 규칙에 따라 파일명을 생성하고 사용자가 지정한 Windows 경로(비-Downloads 드라이브 또는 NAS/UNC 경로 가능) 아래의 Project → (선택)Sequence → (선택)Shot → Asset Bucket 구조로 라우팅합니다. Session이 꺼져 있거나 대상 사이트/확장자가 허용 목록에 없으면 Chrome의 일반 다운로드 동작이 그대로 유지됩니다. Native Messaging으로 한 번 설치하는 Windows Local Agent가 Chrome API가 접근할 수 없는 목적지까지 실제 파일 이동을 담당합니다.

## B. 핵심 기술 결정 (Key Technical Decision)

**Chrome Extension + Windows Local Agent(Native Messaging) — MVP부터 필수, 선택 사항 아님.**

| | A. Extension only | B. Extension + Local Agent |
|---|---|---|
| 임의 드라이브 (D:\, Z:\) | ❌ 불가능 — API가 Downloads 상대 경로로 제한됨 | ✅ Agent는 일반 Windows 프로세스로 동작 |
| NAS / UNC | ❌ 불가능 | ✅ Agent는 사용자 권한 수준의 전체 FS 접근 가능 |
| 파일명 제어 | ✅ `onDeterminingFilename`으로 가능(Downloads 상대 경로 한정) | ✅ (여전히 스테이징 용도로 사용) |
| 충돌 감지(목적지 폴더 조회) | ❌ Extension은 임의 폴더를 읽을 수 없음 | ✅ Agent가 목적지 폴더를 stat/조회 가능 |
| 보안 표면 | 작음 | 큼 — Native Host 설치, 레지스트리, stdio 프로토콜 |
| 설치 난이도 | Extension만 로드 | Extension + 1회성 Agent 설치(레지스트리 + 시작프로그램 등록) |
| 유지보수 | 단순 | 두 배포물을 버전 맞춰 관리 |
| 추천 여부 | 범위가 "Downloads 하위 폴더만"으로 축소될 때만 | **예 — 요구된 제품에는 필수** |

제품이 명시적으로 커스텀 드라이브 문자와 NAS 지원(§3)을 요구하므로, Option A는 핵심 가치 제안을 아예 구현할 수 없습니다. 따라서 "A로 시작해서 나중에 B 추가"는 성립하지 않습니다. 나중으로 미룰 수 있는 것은 Agent의 존재 여부가 아니라 Agent의 정교함(SQLite 히스토리, Windows Service화, 코드 서명 등)입니다.

## C. 아키텍처 (ASCII Diagram)

```
Chrome (Windows)
├─ Popup UI (React)                — 세션 토글, 워크스페이스 필드, 네이밍, 실시간 미리보기
├─ Options Page (React)            — 고급 설정 (루트, 프리셋, 버킷, 템플릿 - Phase 2+)
├─ Background Service Worker (MV3)
│   ├─ session-manager             — AI Session on/off + 지속되는 컨텍스트
│   ├─ source-detection            — adapter 레지스트리 (chatgpt.ts, gemini.ts, ...)
│   ├─ job-manager                  — DownloadJob 생성/상태머신, Session Snapshot 캡처, Index 예약
│   ├─ download-listener           — chrome.downloads 훅, 스테이징 하위 폴더로 리다이렉트
│   ├─ completed-queue              — 다운로드 완료된 Job을 native-client로 전달하는 대기열
│   ├─ native-client                — chrome.runtime.connectNative 래퍼, jobId 기반 요청/응답 상관관계
│   └─ notifier                    — 단일/배치 토스트 + Recent Activity 버퍼
└─ Content Scripts (chatgpt.com, gemini.google.com 한정)
    └─ intent-ping                 — "이 탭에서 다운로드 관련 클릭이 발생했다"는 경량 신호
        │
        │  chrome.downloads API (Downloads 디렉터리 내부로 한정)
        ▼
   OS Downloads 폴더 / _DownloadOrganizer_staging/<uuid>.ext
        │
        │  Native Messaging (stdio, JSON, 경로 정보 + jobId만 담은 작은 메시지)
        ▼
Windows Local Agent (Node.js/TypeScript, 단일 실행 파일로 패키징)
├─ Native Messaging Host            — stdio JSON-RPC 루프, extension id 허용목록 검증
├─ Job Queue / Worker Pool          — 동시성 제한(기본 2)을 가진 File 이동 작업 대기열, Job별 독립 실패 처리
├─ File Router                      — root + hierarchy + bucket 조립, lazy mkdir
├─ Naming/Conflict Resolver         — 최종 파일명 결정 권한자, (예약된) index + 충돌 suffix, O_EXCL 생성
├─ File Mover                       — 목적지 볼륨에 임시복사 → atomic rename → 스테이징 삭제
└─ Local Config                     — %APPDATA%\DownloadOrganizer\config.json (AgentConfig: Root/Template 정본, §F-2) + 로그 파일
        │
        ▼
Windows 파일 시스템 (로컬 드라이브, 매핑된 네트워크 드라이브, UNC/NAS)
```

**왜 스테이징 하위 폴더 방식인가:** Chrome은 Downloads 디렉터리 내부에만 파일을 놓을 수 있으므로, Extension은 조건에 맞는 모든 다운로드를 Downloads 안의 전용 스테이징 하위 폴더(예: `Downloads\_DownloadOrganizer_staging\<uuid>.ext`)로 리다이렉트합니다. `onChanged` → `state: "complete"`가 되면 확정된 **절대 경로**를 얻은 뒤, 원본 파일 바이트도, 조립된 목적지 경로도 아니라 `{jobId, sourcePath, naming: {project, sequence, shot, bucketId, ...}}` 같은 수백 바이트짜리 JSON만 Native Messaging으로 Agent에 전달합니다(`jobId`는 여러 다운로드가 동시에 처리 중일 때 요청/응답을 올바른 `DownloadJob`에 상관관계 짓기 위함 — §F-1 참고; `naming`은 논리적 필드일 뿐 경로가 아님 — §F-2 Root Sandbox Policy). 실제 경로 조립·이동은 전체 파일시스템 권한을 가진 Agent가 **자신이 보관한 Root/FolderTemplate 설정을 기준으로** 수행합니다. 이 방식은 충돌 감지 문제도 함께 해결합니다 — 실제 목적지 폴더를 stat/조회할 수 있는 것은 Agent뿐이므로, Chrome도 Extension도 아닌 Agent가 최종 경로와 파일명의 유일한 결정 권한을 가집니다.

## D. Chrome Extension 아키텍처

- **session-manager**: `SessionState`를 `chrome.storage.local`에 보관하는 단일 소스. 가로채기 로직이 아예 실행될지 여부를 결정하는 가장 먼저 확인되는(가장 저렴한) 게이트.
- **source-detection / adapters**: 각 AI 서비스는 작은 `AISourceAdapter`(`id`, `hostPatterns`, `correlate()` 함수)로 표현됩니다. Runway/Veo/Sora 추가는 새 adapter 파일 1개 + `host_permissions`/`content_scripts` 항목 추가만으로 가능하며, 핵심 파이프라인은 변경되지 않습니다.
- **job-manager**: §F의 게이트를 모두 통과한 순간(=`onDeterminingFilename` 콜백 내부, 동기적으로) `DownloadJob`을 생성하고 `sessionSnapshot`을 캡처하며 `reservedIndex`를 즉시 배정합니다(상세 설계는 새 "다운로드 큐 / Job / 동시성 설계" 절 참고). 여러 다운로드가 근접한 시점에 감지되어도 이 배정은 Extension의 단일 스레드 이벤트 루프 안에서 동기적으로 처리되어 레이스가 발생하지 않습니다.
- **download-listener**: `onDeterminingFilename`에서 세션 ON + adapter 매칭 + 지원 확장자 여부를 확인하고, 모두 참이면 (job-manager가 만든 Job을 참조해) 스테이징 하위 폴더로 임시 고유 이름으로 리다이렉트합니다. `onChanged`가 complete가 되면 Job을 `completed-queue`로 옮깁니다. 조건 중 하나라도 거짓이면 제안 파일명을 반환하지 않습니다(=일반 Chrome 동작 그대로 유지).
- **completed-queue → native-client**: `completed-queue`에 들어온 각 Job은 완료되는 대로(배치로 모으지 않고) 즉시 `route-file` 요청으로 변환되어 Agent에 전송됩니다. `native-client`는 `connectNative`로 얻은 `Port`를 관리하고, `jobId`를 상관관계 키로 사용해 동시에 여러 요청이 미결(in-flight) 상태여도 응답을 올바른 Job에 매칭하며, 타임아웃 처리·Agent 미실행 시 재연결/백오프·실패 시 `notifier` 전달을 담당합니다. 한 Job의 요청/응답 실패가 다른 Job의 처리에 영향을 주지 않습니다(Failure Isolation).
- **content-scripts (intent-ping)**: 파일명/설명을 위해 DOM을 스크래핑하지 않습니다. 유일한 역할은 "이 AI 사이트 탭에서 다운로드 컨트롤과 관련 있을 법한 클릭이 발생했다"는 타임스탬프를 background로 보내는 것뿐이며, 이는 `DownloadItem` 자체가 탭 정보를 제공하지 않을 때 애매한 `chrome.downloads` 이벤트를 탭 출처와 상관관계 짓는 용도로만 씁니다. ChatGPT/Gemini의 DOM이 바뀌어도 파이프라인 자체가 깨지지 않고 상관관계 신뢰도만 낮아지도록 의도적으로 단순하게 유지합니다(Phase 0에서 검증 필요 — §Q 참고).
- **popup/options (React)**: `SessionState`/`Settings` 위의 순수 프레젠테이션 레이어이며, *파일명 미리보기*와 *목적지 미리보기*는 Agent가 사용하는 것과 정확히 동일한 `packages/shared` 함수를 호출하므로, UI 미리보기와 실제 저장 결과가 어긋나는 상황이 구조적으로 발생하지 않습니다. **단, §F-2 Root Sandbox Policy에 따라 이 `Settings`(특히 `defaultRoot`/`folderTemplate`)는 Extension이 소유한 정본이 아니라 Agent로부터 받아온 읽기 전용 캐시입니다** — 오직 화면 표시(미리보기)에만 쓰이며, 실제 `route-file` 요청에는 절대 포함되지 않습니다. 사용자가 Root/Template을 수정하면 `sync-settings`로 Agent에 반영을 요청하고, Agent의 확인 응답을 받은 뒤에야 로컬 캐시를 갱신합니다(낙관적 업데이트 후 Agent 응답으로 확정).

### 기술 스택 결정 (Tech Stack Decisions)

| | Popup/Options UI | Agent 런타임 |
|---|---|---|
| **채택** | **React + TypeScript + Vite** | **Node.js + TypeScript**, 단일 실행 파일로 패키징 (Node SEA / `pkg`) |
| 이유 | 팝업에는 실제로 서로 얽힌 반응형 상태가 많습니다 — 파일명 미리보기, 목적지 미리보기, 커스텀 파일명 토글 하나가 동시에 다른 세 필드를 비활성화하는 등. 수동 DOM 동기화는 오류가 나기 쉬우며, React의 선언적 상태 모델이 미리보기/실제상태 불일치라는 버그 클래스 전체를 없애줍니다. Vanilla TS는 더 가볍지만 이 정도 복잡도에서는 이점이 없습니다. | `packages/shared`(sanitize/파일명 생성/경로 생성/충돌 로직, native-messaging 프로토콜 타입)를 Extension과 Agent가 **문자 그대로 동일한 코드·타입**으로 공유할 수 있습니다 — 재구현도, 팝업 미리보기와 Agent 실제 동작 사이의 드리프트도 없습니다. 두 컴포넌트를 계속 맞춰가야 하는 MVP 단계에서 개발 속도가 빠릅니다. |
| 검토했으나 기각한 대안 | Vanilla TypeScript — 팝업이 대부분 정적일 때만 가치가 있어 기각 | **.NET(C#)** — 장기적으로 Windows 통합(Windows Service, 서명된 MSI, 런타임 번들링 불필요)에 유리하고, **Rust** — 가장 작고 빠른 정적 바이너리. 두 선택지 모두 *MVP 단계*에서는 코드 공유 이점을 잃고 개발 속도가 느려져 기각. **.NET은 Agent가 실제 Windows Service가 되거나, 넓은 배포를 위해 코드 서명이 필요하거나, 시작프로그램 등록 이상의 네이티브 인스톨러가 필요해질 경우 자연스러운 Phase 2+ 후보**입니다. |
| 자동 시작 | 해당 없음 | 시작프로그램(Startup) 폴더 바로가기(설치 스크립트가 생성) — 1인/소규모 제작 워크스테이션 용도이므로 관리자 권한 설치가 필요한 Windows Service보다 단순함을 우선. 다중 사용자/공유 PC 배포가 필요해지면 재검토 |

## E. Windows Agent 아키텍처

- **native-messaging/host**: Native Messaging 프로토콜(4바이트 길이 프리픽스)에 따른 stdio 기반 JSON 메시지 루프. 요청을 처리하기 전 자체 config에 있는 소규모 허용목록으로 호출자 extension id를 검증합니다. 각 요청/응답은 `jobId`로 상관관계를 맺으므로 여러 `route-file` 요청이 동시에 미결 상태여도 안전합니다.
- **Job Queue / Worker Pool**: 들어오는 `route-file` 요청을 즉시 실행하지 않고 내부 큐에 넣고, 설정 가능한 동시성 상한(기본값 2, `Settings.maxConcurrentFileOps`)을 가진 워커 풀로 처리합니다. 이유: 큰 MOV/MP4 이동과 작은 PNG 이동이 동시에 들어와도 NAS 대역폭/동시 핸들 수를 무한히 소모하지 않기 위함이며, 동시성 제한이 없으면 다수의 대용량 파일 이동이 겹칠 때 네트워크 드라이브가 사실상 멈출 수 있습니다(§Q에 실측 필요 항목으로 기록). 큐는 순수 FIFO가 아니라 "각 Job은 독립적으로 성공/실패한다"는 원칙을 지키므로, 앞선 Job의 실패가 뒤 Job의 처리를 막지 않습니다(Failure Isolation).
- **file-router**: Extension이 보낸 논리적 `naming` 필드(경로 아님)와 Agent 자신의 `AgentConfig.defaultRoot`/`FolderTemplate`를 기준으로 목적지 폴더 배열을 조립하고, 비어 있는 선택적 세그먼트는 제거하며, 정규화된 최종 경로가 Root 하위인지 검증한 뒤(§F-2 `resolveSafeDestination`), 해당 폴더에 첫 실제 파일이 쓰이기 직전에만 `mkdir -p`를 수행합니다(Lazy Folder Creation). Root 밖으로 벗어나는 경로가 계산되면 파일시스템 작업을 전혀 수행하지 않고 `OUTSIDE_ROOT` 오류로 즉시 실패합니다.
- **naming/conflict-resolver**: `packages/shared`와 동일한 sanitize/토큰/폴백 로직을 다시 실행합니다(Extension이 제안한 파일명을 최종본으로 신뢰하지 않음). `{index}` 토큰 값은 Extension이 감지 시점에 이미 배정한 `job.reservedIndex`를 그대로 사용하며, Agent는 이 값을 재계산하지 않습니다 — 대신 계산된 최종 파일명이 실제로 디스크에 이미 존재하는 "물리적 충돌"만 감지합니다. 두 메커니즘은 목적이 다릅니다: **Index 예약**(Extension, 의미 있는 순번 부여, §F-1) vs **충돌 suffix**(Agent, 실제 디스크 상태에 대한 안전망). 물리적 충돌은 `fs.open(path, 'wx')`(O_EXCL) 시도 후 `EEXIST`가 나면 `_002`, `_003`... 형태로 suffix를 증가시키는 방식으로 해결하며, 상한(예: 999)을 두고 그 이상은 명확히 실패 처리합니다. Agent는 또한 `get-max-index` 요청(§F-1)에 응답해 목적지 폴더를 스캔하고 기존 파일명 패턴에서 최대 index를 찾아 반환함으로써, Extension의 인메모리 카운터가 이전 세션에서 이미 저장된 파일들과 어긋나지 않도록 돕습니다.
- **file-mover**: 스테이징된 파일을 목적지 볼륨의 `<destFolder>\.<name>.aias-tmp`로 복사 → 크기 검증 → 같은 볼륨 내 atomic rename → 그제서야 스테이징 원본 삭제 및 (Extension을 통해) 스테이징 항목에 대한 `chrome.downloads.erase` 호출까지 수행합니다. NAS 경로에 대한 모든 FS 호출은 타임아웃으로 감싸서(끊긴 UNC 경로에서 Windows가 수십 초씩 멈출 수 있음) 연결이 끊긴 NAS가 Agent 전체를 블로킹하지 않도록 합니다.
- **config/installer**: 1회성 설치 스크립트가 native-messaging-host manifest JSON(`allowed_origins`를 배포용 Extension ID 하나로 고정, §F-2), HKCU 레지스트리 키, 시작프로그램 바로가기를 생성합니다(MVP에서는 완전한 Windows Service가 아님 — 단일 사용자 창작 워크스테이션 용도에 맞게 관리자 권한 설치 없이 단순하게 구성). 설치 시 사용자가 지정한 `defaultRoot`로 `AgentConfig`를 초기화하며, 이후 이 파일이 Root/FolderTemplate의 유일한 정본입니다.

## F. 다운로드 소스 감지 흐름 (Download Detection Flow)

특정 신호 하나에 의존하지 않고, 가장 저렴한 것부터 계층적으로 확인합니다:

1. **AI Session 게이트** (인메모리 플래그) — OFF면 URL/호스트 검사 이전에 즉시 아무 것도 하지 않고 종료합니다.
2. **Host/Origin 게이트** — `host_permissions`을 `chatgpt.com`, `chat.openai.com`, `gemini.google.com`으로만 한정합니다(adapter당 1개 항목, 확장 가능). 다운로드의 `url`/`finalUrl`/`referrer`가 이 중 하나와 일치해야 합니다.
3. **탭 출처 상관관계 (검증 필요한 미확정 사항)** — `chrome.downloads.DownloadItem`은 원본 탭을 안정적으로 노출하지 않습니다. 계획은 (§D의) `intent-ping`을 가장 최근 신호로 사용해, 짧은 시간창(예: 3초) 내에 일치하는 origin 탭에서 발생했는지로 상관관계를 짓는 것이며, `referrer`만 신뢰하지 않습니다(`blob:` URL 다운로드에서는 비어 있을 수 있음). **이 동작은 실제 ChatGPT/Gemini 다운로드 UI를 대상으로 실증 검증이 반드시 필요합니다** (§Q 1–2 참고).
4. **확장자/MIME 게이트** — `png/jpg/jpeg/webp/mov/mp4/webm`에 대해서만 진행하며, Session ON + 사이트 일치 상태여도 그 외 파일(PDF, ZIP, EXE)은 무시됩니다.
5. 네 게이트를 모두 통과했을 때만 다운로드를 스테이징으로 리다이렉트하고 파이프라인을 계속 진행합니다.

## F-1. 다운로드 큐 / Job 모델 / 동시성(Concurrency) 설계

여러 이미지·영상이 동시에 다운로드되는 상황(연속 클릭, Download All, 큰 MOV 다운로드 중 이미지 추가 다운로드)은 예외가 아니라 일반적인 사용 패턴으로 간주하고 MVP부터 지원합니다. 이 절의 내용은 §C(아키텍처)·§I(상태 모델)·§H(네이밍)·§P(테스트)에 모두 반영되어 있습니다.

### DownloadJob — 상태 머신

각 다운로드는 독립적인 `DownloadJob`으로 관리합니다(전체 타입은 §I 참고).

```
detected → queued → downloading → downloaded → moving → saved
                                              └→ failed (Retry 가능, 같은 Job으로 재시도)
   └→ cancelled (Chrome에서 사용자가 다운로드 취소)
```

- `detected`: §F의 4개 게이트를 모두 통과한 시점(`onDeterminingFilename` 콜백 내부). 이 시점에 **동기적으로** `sessionSnapshot`을 캡처하고 `reservedIndex`를 배정합니다(아래 참고).
- `saved`/`failed`/`cancelled`는 종단 상태이며, 한 Job의 종단 상태는 다른 Job에 어떤 영향도 주지 않습니다(Failure Isolation, 아래 참고).

### Session Snapshot — "다운로드 시작 시점의 설정을 고정"

Job이 `detected` 상태가 되는 순간, 현재 `SessionState`(root, project, sequence, shot, bucket, description, namingPreset, customFilenameEnabled, customFilename)를 **깊은 복사**하여 `job.sessionSnapshot`에 저장합니다. 이후 파이프라인의 모든 단계(파일명 생성, 목적지 경로 계산)는 오직 `job.sessionSnapshot`만 참조하며, 라이브 `SessionState`를 다시 조회하지 않습니다.

**왜 필요한가:** 대용량 MOV가 다운로드되는 동안 사용자가 팝업에서 Project나 Description을 바꾸면, 이미 진행 중인 Job의 목적지/파일명이 바뀌어서는 안 됩니다. 새 설정은 그 이후에 `detected`되는 Job부터 적용됩니다. 이는 §G/§H의 `resolveDestinationFolder`/`buildFilename`이 `session` 인자로 항상 `job.sessionSnapshot`을 받는다는 뜻이며, 이 계획의 나머지 부분에서 "session"이라는 표현이 나올 때는 특별한 언급이 없는 한 이 스냅샷을 의미합니다.

### Index Reservation — 동시 감지 시 인덱스 중복/역전 방지

**요구사항:** 5개가 동시에 감지되면 즉시 023–027이 배정되어야 하고, 완료 순서가 025→023→027→024→026처럼 뒤바뀌어도 이미 배정된 파일명을 그대로 유지해야 합니다.

**어디서 배정해야 하는가 — Extension vs Agent:**

- **Extension이 배정해야 합니다 (채택).** 이유는 두 가지입니다. 첫째, "감지 시점"에 즉시 순번을 매겨야 하는데, 감지는 Extension의 `onDeterminingFilename`에서 일어나고 Agent는 다운로드가 *완료된 후*에야 해당 Job의 존재를 알게 됩니다. 배정을 Agent(완료 시점)에 맡기면 큰 MOV가 늦게 끝나는 바람에 나중에 시작된 이미지가 더 앞선 index를 가져가 버립니다 — 이는 정확히 사용자가 피하고 싶어하는 상황입니다. 둘째, MV3 Service Worker의 JS 실행은 단일 스레드이므로, `onDeterminingFilename` 콜백 안에서 `await` 없이 **동기적으로** 인메모리 카운터를 읽고 증가시키면 진짜 레이스 컨디션이 발생하지 않습니다(5개의 콜백이 "동시에" 도착해도 이벤트 루프가 하나씩 순서대로 실행합니다).
- **주의할 함정:** 카운터를 `chrome.storage.local`에서 매번 `await get()` → 계산 → `await set()`으로 읽고 쓰면, 두 콜백의 `await` 사이에 이벤트 루프가 끼어들어 둘 다 같은 값을 읽는 진짜 레이스가 발생할 수 있습니다. 따라서 **인메모리 변수를 유일한 정본(source of truth)으로 두고 동기적으로 증가시킨 뒤, 영속화(`storage.local` 저장)는 그 뒤에 비동기로(fire-and-forget) 수행**합니다. Service Worker가 재시작되면 시작 시 1회 `storage.local`에서 마지막 값을 읽어 인메모리 카운터를 복원합니다.
- **Agent의 역할은 "안전망"입니다.** Extension의 카운터는 디스크의 실제 상태(예: 이전 세션에서 이미 001~010까지 저장됨, 또는 다른 경로로 수동 복사된 파일)를 알 수 없습니다. 이를 보완하기 위해 Native Messaging에 `get-max-index` 요청(§I 참고)을 추가합니다: 사용자가 팝업에서 Project/Sequence/Shot/Bucket 조합을 새로 선택하거나 처음 사용할 때, Extension은 Agent에 "이 목적지 폴더에서 이 네이밍 패턴에 해당하는 기존 파일 중 최대 index가 얼마인가"를 1회 질의하고, `max(로컬 카운터, Agent가 보고한 최대값 + 1)`을 다음 배정값으로 재조정합니다. 다운로드마다 매번 묻는 것이 아니라 **워크스페이스 컨텍스트가 바뀔 때만** 조회하므로 비용이 낮습니다. 그래도 값이 어긋나 물리적 파일명 충돌이 발생하면 Agent의 O_EXCL 충돌 suffix(§H, §E)가 최종 안전망 역할을 합니다.
- **정리:** Index 예약(의미 있는 순번, Extension 담당) ≠ 충돌 suffix(디스크 충돌 안전망, Agent 담당). 둘 다 있어야 하며 역할이 다릅니다.

### Processing Queue — 다운로드와 파일 이동을 분리

```
Browser Download → DownloadJob(detected, index 예약됨) → (다운로드 완료 대기)
                 → Completed Download Queue → native-client → Agent Job Queue/Worker Pool → File Router → Destination
```

- Chrome 자체는 여러 다운로드를 이미 동시에 진행할 수 있으므로 이 단계는 제한하지 않습니다.
- "완료된 다운로드"가 실제 파일 이동을 기다리는 단계(Completed Download Queue, Extension 쪽)와 "Agent가 실제로 옮기는" 단계(Job Queue/Worker Pool, Agent 쪽)를 분리한 이유는, 대용량 MOV 이동이 오래 걸리는 동안에도 작은 이미지들의 감지·인덱스 배정·다운로드 자체는 전혀 막히지 않게 하기 위함입니다.
- **동시성 제한이 필요한가 → 예.** Agent가 받은 `route-file` 요청을 제한 없이 모두 동시에 실행하면, 특히 NAS 대상일 때 다수의 대용량 파일 복사가 네트워크 대역폭/SMB 연결을 동시에 점유해 개별 작업이 모두 느려지거나 타임아웃을 유발할 수 있습니다. Agent는 워커 풀 방식(기본 동시성 2, `Settings.maxConcurrentFileOps`로 조정 가능)으로 큐를 처리합니다. 실제 적정값(2가 맞는지, 로컬 드라이브와 NAS를 다르게 둬야 하는지)은 Phase 0/1에서 실제 NAS로 실측이 필요합니다(§Q에 기록).

### Failure Isolation — 한 Job의 실패가 다른 Job을 막지 않음

각 Job은 독립적으로 처리되고 독립적인 `status`/`error`를 가집니다. 001이 저장되고 002가 실패하고 003이 저장되는 상황에서, 002의 실패는 003의 처리를 막지도, 이미 저장된 001을 롤백하지도 않습니다. **어떤 배치도 "성공한 파일까지 함께 삭제"하는 rollback을 수행하지 않습니다.** 실패한 Job만 `[Retry]`로 재시도 가능하며, 재시도는 **같은 `reservedIndex`/`destinationPath`/`finalFilename`을 재사용**합니다(새 index를 다시 뽑지 않음 — 그렇지 않으면 사용자가 이미 본 미리보기 파일명과 실제 저장된 파일명이 달라질 수 있음).

### Cancellation — 취소된 Job의 index 처리

Chrome에서 사용자가 다운로드를 취소하면(`onChanged`의 `state: "interrupted"`, `error: "USER_CANCELED"`) 해당 `DownloadJob`은 `cancelled` 상태가 됩니다. 취소는 Job이 아직 `downloaded` 상태에 도달하기 전에만 발생할 수 있으므로(완료된 다운로드는 Chrome에서 더 이상 취소할 수 없음), Agent나 파일 이동 로직에는 영향이 없습니다.

**정책(채택): 취소/영구 실패한 Job의 `reservedIndex`는 재사용하지 않고 비워둡니다(gap 허용).** 예: 023 saved, 024 cancelled, 025 saved → 024는 다시 쓰이지 않습니다. 이유: index를 재사용하려면 "누가 이 index를 가져갈 자격이 있는가"를 다시 판단해야 하는데, 이는 또 다른 레이스/혼란의 원인이 됩니다. gap이 있는 시퀀스(001, 002, 004...)는 로그와 추적성 관점에서 훨씬 안전하며, 파일명이 한 번 결정되면 그 의미(=몇 번째 시도였는지)가 영구적으로 보존됩니다. Phase 2에서 원한다면 "gap 정리(compact/renumber)" 도구를 별도 옵션으로 고려할 수 있지만 기본값은 아닙니다.

### Batch UI — 다운로드가 여러 개일 때 토스트를 스팸하지 않음

동시에 진행 중이거나 큐에 있는 Job이 2개 이상이면 개별 "Saved" 토스트 대신 집계형 배치 토스트로 전환합니다.

```
Saving 8 AI assets...
5 saved · 2 downloading · 1 queued
        ↓ (모두 종료되면)
8 assets saved                [View activity]
```

- 진행 중인 Job이 1개뿐이면 기존의 단일 "Saved / 파일명 / 경로" 토스트를 그대로 사용합니다(§M).
- 배치 토스트는 진행 상황이 바뀔 때마다(각 Job의 상태 전이 시) 갱신되며, `[View activity]`를 누르면 아래 Recent Activity 목록을 보여줍니다.

### Recent Activity — 최근 저장 목록 (경량)

전체 히스토리/검색 화면은 만들지 않고, 최근 10~20개 Job의 상태를 보여주는 짧은 목록만 제공합니다(팝업의 접이식 섹션 또는 Options 페이지).

```
✓ SH020_IMG_023.png
✓ SH020_IMG_024.png
↓ SH020_VID_025.mov      (진행 중)
! SH020_IMG_026.png      (실패 — Retry)
```

내부적으로는 `RecentActivityEntry[]`를 `chrome.storage.local`에 최대 20개 고정 크기 링 버퍼로 저장합니다(§I). 이 데이터 구조 자체는 Phase 1에 포함하되(어차피 Job을 추적하고 있으므로 비용이 거의 없음), 전용 UI 패널 노출은 Phase 1에서는 선택 사항, **Phase 2에서 확정 포함**으로 둡니다(§O).

## F-2. 보안 원칙 (Security Principles)

사내 배포를 전제로, "Agent가 어떤 파일까지 접근할 수 있는가"를 설계 단계에서 명확히 제한합니다. 이 절의 원칙은 §C(아키텍처)·§E(Agent API)·§G(경로 처리)·§I(상태 모델/프로토콜)·§K(권한)·§L(Windows 고려사항)·§M(오류 처리)·§P(테스트)에 모두 반영됩니다.

### Root Sandbox Policy — 핵심 아키텍처 변경: Root의 권한자는 Extension이 아니라 Agent

**원칙:** 모든 자동 파일 작업(생성/이름변경/이동)은 사용자가 지정한 `Default Root`의 하위(descendant)에서만 허용됩니다. Project/Sequence/Shot/Bucket/Custom Folder 등 자동 생성되는 모든 폴더는 예외 없이 Root의 하위여야 합니다.

**설계 변경 (이전 버전 대비):** 이전 초안에서는 Extension이 `destFolder: string[]`(조립된 폴더 세그먼트 배열)를 계산해 Agent에 전달했습니다. 이는 "Agent가 Extension이 준 경로를 그대로 신뢰"하는 구조가 되어 신뢰 경계가 불명확해집니다. **이를 다음과 같이 바꿉니다: Extension은 절대/조립 경로를 전혀 전달하지 않고, `project`/`sequence`/`shot`/`bucketId`(또는 `customFolderName`)/`filename` 같은 논리적 값만 전달합니다. 실제 경로 조립은 오직 Agent가, Agent 자신이 로컬에 보관한(=Extension이 매번 새로 주장할 수 없는) `defaultRoot`/`FolderTemplate` 설정을 기준으로 수행합니다.** 사용자가 팝업/Options에서 Root나 FolderTemplate을 바꾸면 Extension은 `sync-settings` 메시지로 Agent에 반영을 요청하지만, 개별 `route-file` 요청에는 Root/경로 정보를 절대 실어 보내지 않습니다(§I `NativeRequest` 타입 참고). 이렇게 하면 Extension 쪽 버그나 변조가 있어도 Agent가 "그 순간 요청에 실려온 임의의 경로"를 곧이곧대로 쓰는 코드 경로 자체가 존재하지 않습니다.

**Agent 측 경로 처리 알고리즘 (Path Handling, §G와 §L을 대체/보강):**

```
function resolveSafeDestination(agentConfig, naming):
    root = fs.realpathSync(agentConfig.defaultRoot)
    # Root 자체가 없으면 자동 생성하지 않고 즉시 실패 (ROOT_NOT_CONFIGURED / ROOT_UNAVAILABLE)

    segments = []
    for level in agentConfig.folderTemplate.levels:
        raw = naming[level.key]
        if raw:
            clean = sanitizeSegment(raw)              # §H 로직 + 아래 강화 규칙
            segments.push(clean)
        elif level.required:
            reject(MissingRequiredFieldError)
    segments.push(sanitizeSegment(naming.bucketId ?? naming.customFolderName))

    candidate = path.normalize(path.join(root, ...segments))  # lexical 정규화, '..' 등을 여기서 붕괴
    if !candidate.startsWith(root + path.sep):
        reject("OUTSIDE_ROOT")                          # 로그 남기고 파일시스템 작업 전혀 수행하지 않음

    ensureFolderExists(candidate)                        # lazy mkdir (기존 §G 로직)

    resolvedAfterCreate = fs.realpathSync(candidate)      # junction/symlink가 도중에 끼어들지 않았는지 재검증
    if !resolvedAfterCreate.startsWith(root + path.sep):
        reject("OUTSIDE_ROOT")                            # junction escape 방어 (§L)

    return resolvedAfterCreate
```

- `sanitizeSegment`(§H)에 다음을 추가합니다: 정제 후 값이 `""`, `"."`, `".."`이면 (필수 필드면 reject, 선택 필드면 드롭이 아니라 명확히 reject — 의도적인 경로 조작 시도로 간주) 통과시키지 않습니다. 일반적인 sanitize(공백/금지문자 제거)만으로는 `..`을 걸러내지 못하므로 별도 규칙입니다.
- `candidate.startsWith(root + path.sep)` 검사는 **문자열 접두어 검사가 아니라 정규화된 절대경로 기준**으로 수행하며(대소문자 무시 — Windows는 기본적으로 대소문자를 구분하지 않음), `D:\AI_Projects2`가 `D:\AI_Projects`의 prefix로 오탐되지 않도록 구분자(`\`)까지 포함해 비교합니다.
- **읽기 쪽도 동일한 원칙을 적용합니다:** Agent는 `sourcePath`(스테이징된 다운로드 파일)를 읽기 전에, 그 경로가 OS Downloads 디렉터리의 지정된 스테이징 하위 폴더 내부인지 검증합니다. 이는 손상되거나 버그가 있는 Extension이 "다운로드된 파일"이라고 속여 디스크의 임의 파일을 Root 안으로 옮기도록 요청하는 것을 막기 위함입니다 — Agent가 접근 가능한 파일은 "Downloads의 스테이징 폴더(읽기)"와 "Default Root 하위(쓰기)"로 엄격히 양분됩니다.

### AI Session OFF — 명확한 Safety Boundary

AI Session이 OFF이면 Download Organizer는 다운로드에 **전혀** 개입하지 않습니다: rename 없음, move 없음, 폴더 생성 없음, **Local Agent에 어떤 종류의 Native Message도 전송하지 않음**(단순 상태 확인용 `ping`조차 보내지 않음 — Agent가 실행 중인지조차 필요할 때만 확인). 사용자는 Chrome 기본 다운로드/Save As로 원하는 위치에 직접 저장할 수 있으며 이 경로는 완전히 그대로 유지됩니다. 이는 §F의 게이트 1번이 이미 구현하고 있지만, 이번 요구사항으로 이를 "성능 최적화용 조기 종료"가 아니라 **명시적 보안 경계**로 재정의합니다: Session OFF 상태에서 다운로드 이벤트/데이터를 검사하는 코드 경로 자체를 최소화하고(§D `content-scripts`의 intent-ping도 Session이 OFF면 타임스탬프를 기록·전송하지 않도록 함 — 필요 없는 데이터를 애초에 만들지 않음), 이 불변식은 §P에서 "OFF일 때 native message 카운트가 정확히 0인지"를 직접 계측하는 테스트로 검증합니다.

### Local Agent Minimum Privilege — 고정된 API Surface

MVP Agent가 노출하는 Native Messaging 프로토콜은 **정확히 아래 4개 메시지 타입뿐**이며(§I), 그 외의 어떤 동작도 프로토콜 자체에 존재하지 않습니다(런타임 권한 검사로 막는 것이 아니라,애초에 그런 메시지 타입/코드 경로가 없는 방식으로 제한합니다):

| 허용 | 금지 (프로토콜에 아예 없음) |
|---|---|
| Root 하위 폴더 생성 (`route-file` 처리의 일부, lazy) | 임의 파일 삭제 |
| 다운로드된 AI asset rename + Root 하위로 move (`route-file`) | 임의 명령 실행 (arbitrary command execution) |
| Filename 충돌 처리 — 번호 증가만, overwrite 없음 (`route-file`) | PowerShell / CMD 실행 |
| 목적지 존재 여부 확인 (`get-max-index`) | Default Root 밖으로의 파일 이동/쓰기 |
| Root/FolderTemplate 등 설정 동기화 (`sync-settings`) | 기본 overwrite (명시적으로 금지 — 항상 번호 추가: `hero.mov` → `hero_002.mov` → `hero_003.mov`) |
| 연결 확인 (`ping`) | 범용 파일시스템 read/write/exec passthrough |

이 표는 §I `NativeRequest`/`NativeResponse` 유니온 타입과 1:1로 대응하며, Agent 구현체에 새 메시지 타입을 추가하는 것 자체가 리뷰 대상이 되는 명시적 변경이 되도록 의도했습니다.

### Privacy — 완전 로컬 구조

MVP는 클라우드 백엔드 없이 완전히 로컬에서 동작합니다: **텔레메트리 없음, 에셋 업로드 없음, 파일명 업로드 없음, 프로젝트 메타데이터(Project/Sequence/Shot/Description) 업로드 없음, 프롬프트 업로드 없음.** Extension ↔ Local Agent 간 통신은 Native Messaging(로컬 stdio)만 사용하며 외부 네트워크 호출은 전혀 발생하지 않습니다(§K의 최소 `host_permissions`와도 일치 — Agent 자체도 네트워크 클라이언트 코드를 포함하지 않음). Agent의 로컬 로그 파일(§E)은 진단 목적으로만 사용자의 머신에 남으며 어디로도 전송되지 않습니다.

### Chrome Security

- **`allowed_origins` 고정**: Native Messaging host manifest의 `allowed_origins`는 배포용(production) Extension ID 하나로 고정합니다(개발 중에는 §K의 dev-note대로 고정 `"key"`를 사용한 dev extension id). 와일드카드나 여러 id를 허용하지 않습니다.
- **최소 권한**: §K의 권한/`host_permissions` 목록은 이미 지원 AI 사이트로만 한정되어 있으며 `<all_urls>`를 사용하지 않습니다 — 이 원칙을 신규 adapter 추가 시(Phase 2)에도 그대로 유지합니다.
- **입력 신뢰 경계**: Content Script(§D `intent-ping`)가 background로 보내는 값은 "이 origin의 탭에서 다운로드 관련 클릭이 있었다"는 타임스탬프뿐이며, **경로/파일명 조립에는 전혀 사용되지 않습니다** — 최악의 경우에도 이 값이 조작되면 소스 감지 신뢰도(§F 3번 게이트)에만 영향을 주고, 어떤 파일이 어디에 쓰일지에는 영향을 주지 않습니다. Background Service Worker는 어쨌든 이 값을 다시 한번 origin/시간창 검증 없이 신뢰하지 않으며, Local Agent는 (위 Root Sandbox Policy에 따라) Extension이 보내는 어떤 값도 최종 신뢰하지 않고 자체적으로 재검증합니다 — 즉 **검증이 Extension Service Worker와 Local Agent 양쪽에서 독립적으로 이루어집니다.**

## G. 파일 라우팅 알고리즘 (의사코드)

**이 로직은 Agent에서만 실행됩니다** (§F-2 Root Sandbox Policy) — Extension은 `naming`(논리적 필드)만 전달하고, 실제 폴더 세그먼트 조립·Root 결합·경계 검증은 전부 Agent가 자신의 `AgentConfig`(§I)를 기준으로 수행합니다. 아래는 세그먼트 조립(빈 선택 항목 제거) 규칙의 핵심이며, 전체 보안 검증(경로 정규화, Root 밖 탈출 차단, junction 재검증)이 포함된 최종 버전은 §F-2의 `resolveSafeDestination`을 참고하세요 — 이 절의 `resolveDestinationFolder`는 그 함수 내부에서 세그먼트 배열을 만드는 부분에 해당합니다.

```
function resolveDestinationFolder(agentConfig, naming):
    # naming은 job의 sessionSnapshot에서 파생된 논리 필드 (project/sequence/shot/bucketId/customFolderName)
    # — 라이브 SessionState가 아니라 감지 시점에 고정된 값 (§F-1)
    segments = []
    for level in agentConfig.folderTemplate.levels:   # Phase 1: [project, sequence, shot]
        value = naming[level.key]
        if value:  # trim 후 비어있지 않음
            segments.push(sanitizeSegment(value))
        elif level.required:
            throw MissingRequiredFieldError(level.key)
        # optional이면서 비어있으면 -> 빈 세그먼트를 삽입하지 않고 조용히 제거

    segments.push(sanitizeSegment(naming.bucketId ?? naming.customFolderName))
    return segments   # §F-2에서 agentConfig.defaultRoot와 결합 + 경계 검증 후 최종 경로가 됨

function ensureFolderExists(path):
    # lazy creation — 첫 실제 쓰기 직전에만 호출됨
    mkdirRecursive(path)  # 이미 있으면 no-op
```

이 방식은 배열을 join하기 전에 비어 있는 선택적 레벨을 배열에서 걸러내므로, 빈 자리에 placeholder를 넣는 대신 `Galaxy_S27\SH020\Generated`(Sequence 생략)처럼 구멍 없는 경로를 보장합니다.

## H. 네이밍 알고리즘

```
function buildFilename(template, tokens, extension):
    if tokens.customFilenameEnabled:
        return sanitizeSegment(tokens.customFilename) + extension  # 확장자는 항상 원본 미디어 확장자 유지

    slots = parseTemplate(template)          # 예: [identifier, type, description, index]
    values = []
    for i, slot in enumerate(slots):
        if i == 0:
            # 첫 슬롯 = "identifier", 리터럴 토큰명과 무관하게 폴백 체인 적용
            v = tokens.shot || tokens.sequence || tokens.project || "asset"
        elif slot == "description":
            v = sanitizeSegment(tokens.description)   # 비어있거나 공백만이면 ""
        elif slot == "index":
            v = String(tokens.index).padStart(3, "0")  # tokens.index == job.reservedIndex (§F-1에서 감지 시점에 이미 배정됨, 여기서 새로 계산하지 않음)
        else:
            v = tokens[slot] ?? ""
        if v: values.push(v)                 # 빈 슬롯은 빈 문자열로 남기지 않고 제거

    return values.join("_") + extension

function sanitizeSegment(s):
    s = s.trim()
    s = s.replace(/[<>:"/\\|?*\x00-\x1F]/g, "")   # Windows 금지 문자
    s = s.replace(/\s+/g, "_")
    s = s.replace(/_+/g, "_")                       # 중복 구분자 병합
    s = s.replace(/[.\s]+$/, "")                    # 끝의 점/공백 제거 (Windows 규칙)
    if RESERVED_NAMES.has(s.toUpperCase()): s += "_"  # CON, PRN, AUX, NUL, COM1-9, LPT1-9
    return truncateToPathBudget(s)
```

충돌 처리(Agent 측, 레이스 안전 — §E 참고): 후보 경로에 대해 배타적 생성(`wx` 플래그)을 시도하고, `EEXIST`가 나면 숫자 suffix(`_002`, `_003`, ...)를 증가시켜 재시도합니다. exists-check 후 write하는 방식은 레이스 컨디션에 취약하므로 사용하지 않습니다. `overwrite`는 기본값이 아니며 Phase 2의 명시적 설정 뒤에만 존재합니다. 이 suffix는 위 `{index}` 토큰(Extension이 감지 시점에 배정하는 의미 있는 순번, §F-1)과는 별개의 메커니즘이며, "계산된 파일명이 실제로 디스크에 이미 있을 때"만 개입하는 안전망입니다.

## I. 상태 모델 (TypeScript, MVP 기준)

```ts
// packages/shared/types.ts

// Extension 쪽 Settings — §F-2 Root Sandbox Policy에 따라 defaultRoot/folderTemplate/
// assetBuckets/conflictPolicy/maxConcurrentFileOps 부분은 Agent의 AgentConfig(아래)를
// get-settings/sync-settings로 미러링한 "표시 전용 캐시"이며, 실제 파일 작업의 정본이 아님.
// namingPresets(파일명 템플릿 자체)는 경로/보안과 무관하므로 Extension이 계속 소유·정본 관리함.
interface Settings {
  defaultRoot: string;                 // 예: "D:\\AI_Projects" 또는 "\\\\nas\\studio\\AI_Projects" — Agent 캐시
  folderTemplate: FolderTemplate;      // Agent 캐시. Phase 1: 고정 Project/Sequence/Shot; Phase 2: 사용자 편집 가능
  assetBuckets: AssetBucket[];         // Agent 캐시. Phase 1: 고정 4개 (Generated/Reference/Select/Final)
  namingPresets: NamingPreset[];       // Extension 정본. Phase 1: 기본 프리셋 1개
  conflictPolicy: "uniquify";          // Agent 캐시. Phase 2에서 "ask" | "replace" 추가
  maxConcurrentFileOps: number;        // Agent 캐시. Job Queue/Worker Pool 동시성 상한, 기본 2 (§F-1, §Q)
}

interface FolderTemplate { id: string; name: string; levels: FolderLevel[] }
interface FolderLevel { key: string; label: string; order: number; required: boolean }
interface AssetBucket { id: string; label: string; order: number }
interface NamingPreset { id: string; label: string; template: string } // 예: "{shot}_{type}_{description}_{index}"

interface SessionState {
  aiSessionEnabled: boolean;
  currentProject: string;
  currentSequence: string;
  currentShot: string;
  currentBucketId: string;
  currentDescription: string;
  selectedNamingPresetId: string;
  customFilenameEnabled: boolean;
  customFilename: string;
  lastIndexByKey: Record<string, number>;  // §F-1의 Index Reservation 카운터 체크포인트. 키는
                                            // 폴더 경로+mediaType 조합; 인메모리 값이 정본이고
                                            // 이 필드는 Service Worker 재시작 시 복원용 영속화본
}

// §F-1 — 다운로드 감지 시점에 캡처되어 이후 절대 다시 조회되지 않는 불변 스냅샷
interface SessionSnapshot {
  root: string;
  project: string;
  sequence: string;
  shot: string;
  bucketId: string;
  description: string;
  namingPresetId: string;
  customFilenameEnabled: boolean;
  customFilename: string;
}

type DownloadJobStatus =
  | "detected" | "queued" | "downloading" | "downloaded"
  | "moving" | "saved" | "failed" | "cancelled";

// §F-1 — 다운로드 1건 = Job 1개. 동시 다운로드를 독립적으로 추적하기 위한 핵심 단위
interface DownloadJob {
  id: string;                       // Extension이 생성하는 내부 uuid (native messaging jobId로도 사용)
  browserDownloadId: number;        // chrome.downloads의 DownloadItem.id
  originalFilename: string;
  extension: string;                // png/jpg/jpeg/webp/mov/mp4/webm
  mediaType: "image" | "video";
  source: string;                   // AISourceAdapter.id (예: "chatgpt", "gemini")
  detectedAt: number;                // epoch ms
  sessionSnapshot: SessionSnapshot;
  reservedIndex: number;             // 감지 시점에 배정, 이후 절대 재계산하지 않음
  destinationPath?: string;          // Agent의 route-file-result 응답(finalPath)으로만 채워짐 — Extension이 미리 계산하지 않음(§F-2)
  finalFilename?: string;            // 마찬가지로 Agent 확정 후에만 채워짐; 팝업의 실시간 미리보기는 별도로
                                      // packages/shared.buildFilename()을 로컬에서 호출한 "예상값"일 뿐, 이 필드와는 다른 용도
  status: DownloadJobStatus;
  error?: string;
}

// Options/팝업의 Recent Activity 목록용 — DownloadJob의 경량 사본, 최대 20개 링 버퍼
interface RecentActivityEntry {
  jobId: string;
  finalFilename: string;
  status: DownloadJobStatus;
  updatedAt: number;
}

interface AISourceAdapter {
  id: string;
  label: string;
  hostPatterns: string[];
  matchesDownload(ctx: { url: string; referrer?: string; recentIntentPing?: IntentPing }): boolean;
}

// §F-2 Root Sandbox Policy — Agent 자신의 로컬 config가 Root/FolderTemplate의 유일한 정본.
// Extension은 이 값을 만들어 보내지 않고, 오직 sync-settings로 "바꿔달라"고 요청만 함.
interface AgentConfig {
  defaultRoot: string;
  folderTemplate: FolderTemplate;
  assetBuckets: AssetBucket[];
  conflictPolicy: "uniquify";          // overwrite는 MVP 프로토콜에 아예 표현되지 않음 (§F-2)
  maxConcurrentFileOps: number;
  allowedExtensionId: string;          // Native Messaging allowed_origins와 별개로 Agent 자체에서도 재검증
}

// Extension이 Agent에 보내는 값은 "논리적 필드"뿐이며, 조립된 경로나 절대 목적지 경로는
// 프로토콜 어디에도 존재하지 않는다 (§F-2). 실제 경로 조립·경계 검증은 Agent만 수행한다.
interface NamingFields {
  project: string;
  sequence: string;
  shot: string;
  bucketId?: string;
  customFolderName?: string;
  description: string;
  namingPresetId: string;
  customFilenameEnabled: boolean;
  customFilename: string;
}

type NativeRequest =
  | { type: "route-file"; jobId: string; sourcePath: string; extension: string; mediaType: "image" | "video"; reservedIndex: number; naming: NamingFields }
  | { type: "get-max-index"; naming: Pick<NamingFields, "project" | "sequence" | "shot" | "bucketId" | "customFolderName">; pattern: string }  // §F-1 Index Reservation 재조정용
  | { type: "sync-settings"; settings: Omit<AgentConfig, "allowedExtensionId"> }  // Root/Template 등 사용자 설정 변경 반영
  | { type: "get-settings" }   // 팝업 미리보기용 읽기 전용 캐시 갱신 (§D)
  | { type: "ping" };

type NativeErrorCode = "OUTSIDE_ROOT" | "ROOT_NOT_CONFIGURED" | "ROOT_UNAVAILABLE" | "SOURCE_PATH_INVALID" | "CONFLICT_LIMIT_EXCEEDED" | "IO_ERROR";

type NativeResponse =
  | { type: "route-file-result"; jobId: string; ok: true; finalPath: string }
  | { type: "route-file-result"; jobId: string; ok: false; error: string; code: NativeErrorCode }
  | { type: "get-max-index-result"; maxIndex: number }
  | { type: "sync-settings-result"; ok: boolean }
  | { type: "get-settings-result"; settings: Omit<AgentConfig, "allowedExtensionId"> }
  | { type: "pong" };
```

**저장 위치:** `Settings`, `SessionState`, `RecentActivityEntry[]`(최대 20개 링 버퍼) 모두 `chrome.storage.local`에 저장하며, **`storage.sync`는 사용하지 않습니다.** 이유: `defaultRoot`를 비롯한 모든 경로는 본질적으로 특정 머신의 Windows 경로이므로, 다른 머신/OS 프로필로 동기화하면 실제로 깨진 설정을 만들게 됩니다. 또한 `storage.sync`의 용량 제한(전체 약 100KB, 항목당 8KB)은 네이밍 프리셋/버킷이 늘어나면 부족합니다. Agent 쪽 로컬 전용 상태(연동된 extension id, 로그 경로)는 `%APPDATA%\DownloadOrganizer\config.json`(단순 JSON)에 두며, 히스토리/검색 기능이 필요한 Phase 3 전까지는 SQLite를 도입하지 않습니다(§O 참고).

## J. UI 컴포넌트 구조 (Popup, React)

```
<PopupRoot>
 ├─ <SessionHeader>            AI Session ON/OFF + 상태 부제목
 ├─ <DefaultRootDisplay>       읽기 전용 경로 + [Edit] → 인라인 에디터
 ├─ <WorkspaceSection>
 │   ├─ <ProjectField required>
 │   ├─ <SequenceField optional>
 │   └─ <ShotField optional>
 ├─ <BucketSelect>             Generated/Reference/Select/Final
 ├─ <NamingSection>
 │   ├─ <NamingPresetSelect>   (Phase 1: 고정 프리셋 1개, 드롭다운은 자리표시자 역할)
 │   ├─ <DescriptionField optional>
 │   └─ <CustomFilenameToggle> → 켜지면 NamingPresetSelect + DescriptionField 비활성화
 │       └─ <CustomFilenameField>
 ├─ <FilenamePreview>          packages/shared.buildFilename()을 실시간 호출
 ├─ <DestinationPreview>       root/…/bucket 트리 뷰 + 파일명 포함 전체 경로
 ├─ <AgentStatusBadge>         연결됨 / 미실행 / 오류 / 설정 불러오는 중(cold start, §Q 10) — native-client 상태와 연동
 ├─ <SaveToast>                진행 중 Job이 1개일 때: 기존 단일 "Saved" 토스트 (§M)
 ├─ <BatchToast>               진행 중 Job이 2개 이상일 때: 집계형 진행률 토스트 (§F-1) — [View activity] 포함
 └─ <RecentActivityList>       접이식, 최근 10~20개 Job 상태 아이콘 목록 (§F-1) — Phase 1 선택 / Phase 2 확정
```

`<Options>` 페이지(Phase 1: 최소한 — 루트 에디터 + Agent 상태/재설치 링크; Phase 2에서 FolderTemplate 에디터, 다중 프리셋 에디터, 버킷 CRUD, `<RecentActivityList>`의 전체 화면 버전 추가).

## K. 권한 (Permissions, 최소 권한 원칙)

```json
{
  "permissions": ["downloads", "storage", "nativeMessaging", "notifications"],
  "host_permissions": [
    "https://chatgpt.com/*",
    "https://chat.openai.com/*",
    "https://gemini.google.com/*"
  ],
  "content_scripts": [{
    "matches": ["https://chatgpt.com/*", "https://chat.openai.com/*", "https://gemini.google.com/*"],
    "js": ["intent-ping.js"],
    "run_at": "document_idle"
  }]
}
```

의도적으로 제외한 것: `<all_urls>`, `webRequest`/`webRequestBlocking`(payload 가로채기가 필요 없고 `chrome.downloads` 이벤트 + Native Messaging만으로 충분함), `downloads.open`/`downloads.shelf`. Phase 2에서 새 AI 소스를 추가할 때는 `host_permissions` 1줄 + `content_scripts` match 1줄 + adapter 파일 1개만 추가하면 되며, 리뷰 가능한 최소 diff로 유지됩니다. **개발 메모:** unpacked extension의 `"key"`를 초기에 고정해 두세요. Native Messaging host manifest의 `allowed_origins`는 extension id에 종속되는데, 고정하지 않으면 unpacked 리로드마다 id가 바뀝니다. 배포판에서는 `allowed_origins`를 프로덕션 Extension ID 하나로만 고정하며(§F-2 Chrome Security), Agent 자체도 `AgentConfig.allowedExtensionId`로 한 번 더 호출자를 검증합니다(Native Messaging 계층 검증에만 의존하지 않는 이중 방어).

## L. Windows 특화 고려사항

- **드라이브/UNC 가용성**: 라우팅 전에 "드라이브 루트 자체가 없음"(`D:\` 자체에는 `mkdir` 시도하지 않음)과 "경로가 아직 없을 뿐"(안전하게 `mkdir -p` 가능), "네트워크 경로 타임아웃"(명시적 타임아웃으로 감쌈 — Windows는 끊긴 UNC 공유를 탐지하는 데 수십 초씩 걸릴 수 있음)을 구분합니다.
- **MAX_PATH**: 기본 Windows 경로 길이 제한은 260자이며, long-path 지원(`LongPathsEnabled` 레지스트리 또는 앱 매니페스트)이 켜져 있지 않은 한 적용됩니다. 예산 = 260 − (목적지 폴더 길이) − (확장자 길이)로 계산해 *파일명만* 잘라내며, 폴더 계층은 절대 자르지 않습니다. long path 지원 여부가 다른 머신에서 재검증이 필요합니다.
- **예약된 장치 이름**(`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`)은 최종 파일명뿐 아니라 모든 경로 *세그먼트*(폴더명 포함)에 대해 검사해야 합니다.
- **끝의 점/공백**: Windows는 이를 조용히 제거하거나 거부합니다 — OS가 알아서 실패해줄 것이라 기대하지 말고 sanitizer가 명시적으로 제거해야 합니다.
- **볼륨 간 이동**: `fs.rename`은 드라이브/공유 간에는 `EXDEV`로 실패하므로, Mover는 항상 "목적지 볼륨에 임시 복사 → 검증 → 같은 볼륨 내 atomic rename → 원본 삭제" 순서를 따르며, 스테이징(Downloads) 볼륨과 목적지 볼륨 사이에 단순 `rename()`을 시도하지 않습니다.
- **심볼릭 링크/junction 방어**: 쓰기 전에 목적지의 실제 경로(`fs.realpath`)를 확인해, 확정된 `defaultRoot`로 시작하는지 검증합니다. 루트 안에 심어진 junction이 쓰기 위치를 다른 곳으로 리다이렉트하는 공격을 방지합니다. 이는 §F-2 `resolveSafeDestination`의 "폴더 생성 후 재검증" 단계로 구현되며, Windows에서는 특히 `mklink /J`로 만든 junction이 일반 폴더처럼 보이면서 실제로는 다른 볼륨/경로를 가리킬 수 있다는 점이 이 방어가 필요한 구체적 이유입니다.

## M. 오류 / 복구 전략

원칙: **목적지 쓰기가 검증되기 전까지 Downloads 안의 스테이징 파일은 절대 삭제하지 않습니다.** 어떤 실패 상황에서도 사용자에게는 복구 가능한 파일이 남아야 하며, 파일이 유실되어서는 안 됩니다.

| 상황 | 동작 |
|---|---|
| Default Root 미설정 | Session은 켤 수 있지만 download-listener는 "먼저 Default Root를 설정하세요" 토스트만 띄우고 아무 것도 하지 않음 — 파일은 일반 Chrome 다운로드로 남음 |
| 루트 드라이브/NAS 연결 끊김 | 이동 실패, 스테이징 파일 유지, 토스트: *"Z:\Studio에 저장하지 못했습니다" [Retry] [Save to Downloads]* — "Save to Downloads"는 이미 스테이징된 파일을 그 자리에서 이름만 바꿔 남겨둠 |
| 파일명 너무 김 / 예약어 | 실제 쓰기 시도 전에 sanitizer/truncation이 실행됨 — 정상 사용에서는 오류로 나타나지 않아야 함. 그래도 예산을 초과하면 description을 먼저 자르고, 그래도 안 되면 조용히 손상시키지 않고 명확히 실패 처리 |
| 동일 파일명 | O_EXCL + suffix 증가로 자동 해결(§H) — 절대 조용히 덮어쓰지 않음 |
| Chrome에서 다운로드 취소/실패 | `onChanged`가 `state: complete`에 도달하지 않아 파이프라인이 트리거되지 않음 — no-op |
| Agent 미실행 | `native-client` 재연결 시도 + 타임아웃; 토스트 *"Local Agent가 실행 중이 아닙니다" [Open Agent] [Save to Downloads]*; 파일은 스테이징에 유지됨 |
| Extension↔Agent 핸드셰이크 실패 | 위와 동일 처리 + 진단을 위해 Agent 로컬 로그 파일에 기록 |
| AI 소스 감지 불확실 | 실패 시 닫힘(fail closed) — §F의 게이트가 모두 명확히 통과하지 않으면 추측하지 않고 일반(비-AI) 다운로드로 취급 |
| 여러 Job 중 일부만 실패 (동시 다운로드) | 실패한 Job만 `failed` 상태 + Retry; 이미 `saved`된 다른 Job은 절대 롤백/삭제하지 않음(§F-1 Failure Isolation) |
| Job Retry | 같은 `reservedIndex`/`destinationPath`/`finalFilename`을 재사용하여 재시도 — 새 index를 다시 뽑지 않음(§F-1) |
| 다운로드 도중 Chrome에서 취소 | Job은 `cancelled`로 전이되고 `reservedIndex`는 재사용하지 않고 비워둠(gap 허용, §F-1) |
| 계산된 목적지가 Default Root 밖 (버그/변조/junction escape) | 파일시스템 작업을 **전혀 수행하지 않고** `OUTSIDE_ROOT`로 즉시 실패 + Agent 로컬 로그에 기록(§F-2) — 이 경로는 정상 사용에서는 도달하지 않아야 하며 도달 자체가 조사 대상 |
| Default Root가 Agent에 아예 설정되지 않음 | `ROOT_NOT_CONFIGURED`로 즉시 실패, 스테이징 파일 유지, 팝업에 설정 유도 토스트(§F-2) |
| overwrite가 필요해 보이는 상황(동일 파일명) | 절대 자동 overwrite하지 않음 — 항상 O_EXCL + 번호 증가(§H, §F-2 Minimum Privilege). 사용자가 명시적으로 요청해도 MVP 프로토콜에는 overwrite 메시지 자체가 없음(Phase 2에서만 옵션으로 검토) |

## N. 추천 저장소 구조 (Repository Structure)

```
apps/
  extension/                  # MV3, TypeScript + React + Vite
    src/
      background/             # session-manager, source-detection, job-manager,
                               # download-listener, completed-queue, native-client, notifier
      popup/                  # React 컴포넌트 (§J 참고)
      options/
      content-scripts/        # intent-ping.ts
      adapters/                # chatgpt.ts, gemini.ts (+ Phase 2에서 runway.ts, veo.ts, sora.ts)
    manifest.json
  agent/                       # Node.js + TypeScript, 단일 실행 파일로 패키징
    src/
      native-messaging/
      job-queue/               # 동시성 제한을 가진 Worker Pool (기본 2, §F-1)
      file-router/
      naming/                  # packages/shared를 재사용하는 얇은 래퍼
      file-mover/
      config/
      installer/               # 레지스트리 키 + native-messaging manifest + 시작프로그램 바로가기
    build/
      pkg.config.json          # win-x64 크로스 컴파일 타깃 설정 (부록 참고)
      installer.iss            # Inno Setup 스크립트 (부록 참고)
packages/
  shared/                      # 순수 TS, Extension과 Agent가 모두 사용 — sanitize/build-filename/
                               # build-path/충돌 로직과 NativeRequest/NativeResponse +
                               # Settings/SessionState 타입의 단일 소스
docs/
  adr/                         # 예: 0001-extension-plus-agent-required.md — §Context의
                               # chrome.downloads 경로 제약 검증 결과 기록
.github/
  workflows/
    windows-ci.yml             # windows-latest 러너: Native Messaging/레지스트리/실제 드라이브
                               # 테스트 + Inno Setup 인스톨러 빌드 (부록 참고)
```

`packages/shared`가 존재하는 이유는 팝업의 실시간 미리보기와 Agent의 실제 디스크 쓰기가 절대 어긋나지 않도록 하기 위함입니다 — 둘 다 동일한 `buildFilename`/`resolveDestinationFolder` 함수를 호출합니다.

## O. 구현 단계 (Implementation Phases)

**Phase 0 — 기술 스파이크** (실제로 만들기 전에 리스크부터 제거)
- `downloads`+`storage` 권한과 chatgpt.com/gemini.google.com에 한정된 `host_permissions`만 가진 최소 MV3 스켈레톤(`manifest.json` + `background.js` 하나)으로, 실제 이미지/영상 다운로드 시 발생하는 `onCreated`/`onDeterminingFilename` 이벤트의 모든 필드를 로깅합니다.
- 최소 Native Messaging 왕복 테스트: "hello" Node 스크립트 + manifest + HKCU 레지스트리 키를 (Windows에서) 준비해, Extension이 `{type:"ping"}`을 보내고 `{type:"pong"}`을 받는지 확인합니다 — 실제 File Router를 만들기 전에 등록 파이프라인 전체를 검증합니다.
- 스테이징 하위 폴더 + `onChanged: complete`가 올바른 절대 경로를 제공하는지, `chrome.downloads.erase`/`removeFile`이 `chrome://downloads`에 깨진/유령 항목을 남기지 않고 스테이징 항목을 정리하는지 확인합니다.
- 산출물: `docs/adr/0001-extension-plus-agent-required.md`에 발견 사항 기록 — 소스 감지가 실제로 불안정한 것으로 판명되면 Phase 1을 재구성할 수 있음.
- **이 단계는 반드시 실제 Windows 환경(또는 GitHub Actions `windows-latest` 러너)에서 실행해야 합니다** — Mac에서는 레지스트리 등록과 Native Messaging 실동작을 검증할 수 없습니다(부록 참고).

**Phase 1 — MVP** (Extension과 Agent를 함께 출시)
- `packages/shared`: `sanitizeSegment`, `buildFilename`, `resolveDestinationFolder`, 충돌 suffix 로직, 공유 타입(`DownloadJob`, `SessionSnapshot` 포함) — Chrome/Windows 의존성 없이 완전히 단위 테스트 가능(Mac에서 개발 가능).
- `apps/agent`: `native-messaging/host.ts`(jobId 상관관계 포함), `job-queue/workerPool.ts`(동시성 상한, 기본 2), `file-router/resolvePath.ts`, `naming` 래퍼(`get-max-index` 처리 포함), `file-mover/moveFile.ts`(O_EXCL + 임시복사-rename), `config/agentConfig.ts`, `installer/install.ts`(레지스트리 + manifest + 시작프로그램 바로가기).
- `apps/extension`: `background/*`(session-manager, `adapters/chatgpt.ts` + `adapters/gemini.ts`를 포함한 source-detection, **job-manager**(Session Snapshot 캡처 + Index Reservation), download-listener, **completed-queue**, native-client, notifier(단일/배치 토스트)), 고정 3단계 계층과 고정 4개 버킷을 사용하는 `popup/*` 컴포넌트 트리(§J), 기본 내장 네이밍 프리셋 1개, 커스텀 파일명 오버라이드, 실시간 미리보기.
- **동시 다운로드 지원은 Phase 1의 필수 요구사항입니다** (연기 대상 아님): DownloadJob 상태 머신, Session Snapshot, Index Reservation(Extension 동기 카운터 + Agent `get-max-index` 재조정), Job Queue/Worker Pool 동시성 제한, Failure Isolation, Cancellation(index gap 정책)까지 모두 §F-1대로 Phase 1에서 구현합니다. `RecentActivityEntry[]` 데이터 구조(20개 링 버퍼)도 Phase 1에 포함하되, 전용 `<RecentActivityList>` UI 노출은 선택 사항입니다(확정 포함은 Phase 2).
- Phase 1에서 명시적으로 **제외**(연기): 편집 가능한 `FolderTemplate`, 다중 네이밍 프리셋, 고정 4개를 넘는 커스텀 버킷, 버전 계보(`_v001`), ChatGPT/Gemini 이외의 adapter, SQLite/히스토리, index gap "compact/renumber" 도구.

**Phase 2 — 고급 Folder Template & Naming**
- Options에 `FolderTemplate` CRUD UI 추가; `file-router`를 고정된 project/sequence/shot 필드 대신 임의의 `FolderLevel[]`을 순회하도록 일반화.
- 커스텀 `AssetBucket` 관리(추가/삭제/재정렬).
- 네이밍 프리셋 에디터(토큰 기반 템플릿 빌더), 다중 프리셋 저장.
- 신규 adapter: `runway.ts`, `veo.ts`, `sora.ts` — Phase 1 추상화가 실제로 통함을 증명. 각각 파일 1개 + `host_permissions`/`content_scripts` 1줄.
- `conflictPolicy`에 `"ask"`, `"replace"`(명시적 확인 포함) 추가, 기본값은 여전히 `"uniquify"`.
- Options 페이지에 `<RecentActivityList>` 전체 화면 버전 확정 포함; 필요하면 index gap "compact/renumber" 도구를 명시적 옵션(기본 off)으로 추가.
- `Settings.maxConcurrentFileOps`를 Options에서 사용자가 조정 가능하게 노출(로컬 드라이브 vs NAS를 다르게 두는 것이 Phase 0/1 실측에서 필요하다고 판명되면, 볼륨 타입별 별도 상한 고려).

**Phase 3 — Asset 메타데이터 / 히스토리**
- Asset identity별 버전 계보(`_v001`, `_v002`) 추적; 저장 히스토리 조회를 위해 Agent 로컬 상태를 JSON에서 SQLite(`better-sqlite3`)로 마이그레이션 — 이 시점에서 Agent 패키징 방식을 재검토해야 함(네이티브 애드온이 단일 실행 파일 번들링을 복잡하게 만들 수 있음, §Q 참고).
- Options 페이지 히스토리 브라우저(최근 저장 목록, "폴더 열기", 마지막 이동 취소).

## P. 테스트 계획

- **단위 테스트 (`packages/shared`)**: sanitizer 엣지 케이스(예약어, 끝의 점/공백, 유니코드/한글, 이모지, 빈 description, 중복 구분자 방지 — Sequence가 비어 있을 때 빈 세그먼트 없이 `Galaxy_S27\SH020\Generated`가 나오는지 명시적으로 검증); 네이밍 폴백 체인; 충돌 suffix 증가. Vitest 사용, **Mac에서 전부 실행 가능**.
- **동시성/Job 단위 테스트 (`background/job-manager`)**: (a) 동일 tick 안에서 5개의 `onDeterminingFilename` 콜백을 동기적으로 연달아 호출해 023–027처럼 중복 없는 연속 index가 배정되는지 검증; (b) 완료 순서를 025→023→027→024→026처럼 뒤섞어도 각 Job의 `finalFilename`이 감지 시점에 배정된 값과 동일하게 유지되는지 검증; (c) Job이 `detected`된 뒤 `SessionState`를 변경해도 해당 Job의 `sessionSnapshot`/목적지/파일명이 바뀌지 않는지 검증(Session Snapshot 불변성); (d) 취소된 Job의 `reservedIndex`가 이후 다운로드에 재사용되지 않는지(gap 유지) 검증. 모두 Mac에서 순수 로직으로 실행 가능.
- **Agent 단위 테스트**: mock `fs`를 이용한 `file-router` 경로 해석; 동시 "생성" 시도 2건으로 `file-mover`의 O_EXCL 레이스 시뮬레이션; 느리거나 에러를 내는 mock `fs`로 드라이브 연결 끊김 타임아웃 처리 검증; `job-queue/workerPool`이 설정된 동시성 상한을 넘지 않는지, 한 Job의 실패가 큐에 남은 다른 Job의 처리를 막지 않는지(Failure Isolation) 검증; `get-max-index`가 기존 파일명 패턴에서 올바른 최댓값을 스캔하는지 검증. **Mac에서 mock 기반으로 개발 가능하지만, 최종 검증은 반드시 Windows에서 재실행.**
- **Agent 통합 테스트**: (a) 같은 드라이브, (b) 두 번째 로컬 드라이브 문자, (c) 매핑된 네트워크 드라이브(예: `subst` 또는 로컬 SMB 공유)에서 실제 임시 폴더로 테스트 — 볼륨 간 복사+rename 대체 로직과 MAX_PATH 절단 로직을 실제 Windows 파일시스템에서 검증. **Windows 환경 필수 (부록 참고).**
- **보안 테스트 (§F-2, 필수 — Mac에서 mock으로 대부분 개발 가능, Windows에서 junction 관련 항목 재검증)**: `project`/`sequence`/`shot`/`description`에 `..`, 절대경로(`C:\Windows`), 드라이브 문자 변경 시도 등을 주입해 `sanitizeSegment`가 거부/무해화하고 최종 경로가 항상 Root 하위로만 정규화되는지 검증; Root 안에 만든 junction/symlink가 실제로는 Root 밖을 가리키도록 구성한 뒤 `resolveSafeDestination`의 생성-후-재검증 단계가 `OUTSIDE_ROOT`로 막는지 검증(Windows 필수); 등록되지 않은/변조된 extension id로 Native Messaging 연결을 시도했을 때 Agent가 `AgentConfig.allowedExtensionId` 검증으로 거부하는지 검증; `sourcePath`로 Downloads 스테이징 폴더 밖의 임의 경로(예: 사용자 문서 폴더의 파일)를 지정했을 때 Agent가 읽기를 거부하는지 검증; 동일 파일명 충돌 시 어떤 설정에서도 자동 overwrite가 절대 발생하지 않는지(항상 O_EXCL 경로만 타는지) 검증.
- **AI Session OFF 격리 테스트**: Session을 OFF로 둔 채 지원 사이트에서 지원 확장자를 다운로드하고, `native-client`가 보낸 Native Message 수가 정확히 0인지(연결 자체도 시도하지 않는지) 계측; Content Script의 intent-ping도 Session OFF 상태에서는 아무 것도 background로 전송하지 않는지 검증(§F-2 Privacy/Safety Boundary).
- **Extension 통합 테스트**: `blob:` URL / `<a download>` 클릭을 시뮬레이션하는 로컬 정적 페이지에 Playwright `--load-extension`으로 접근해, 운영 중인 ChatGPT/Gemini에 의존하지 않고 CI에서 `onDeterminingFilename` 가로채기를 검증.
- **Native Messaging End-to-End 테스트**: Windows 머신/VM에 실제 설치된 Agent와 스크립트로 통신하는 Extension, 깨끗한 머신 상태에서의 레지스트리+manifest 설치/제거 스크립트 실행 포함.
- **수동 테스트 매트릭스 (필수 — 실제 서비스 이용약관 때문에 완전 자동화 불가)**: ChatGPT/Gemini에서의 이미지 다운로드; AI Session OFF 시 동작 불변 확인(문자 그대로 아무 변화 없어야 함); 비-AI 사이트의 PDF/ZIP 통과; 세션 중 드라이브 연결 끊김; NAS 접근 불가; 같은 파일명을 연속으로 두 번 저장; 한글/이모지/슬래시가 포함된 description; MAX_PATH에 근접하는 Project+description 조합; **ChatGPT/Gemini에서 이미지 여러 장을 빠르게 연속 클릭해 실제로 인덱스가 순서대로/중복 없이 배정되는지**; **다운로드 중 하나를 Chrome에서 취소하고 나머지가 정상 저장되는지 + index gap이 남는지**; **다운로드 도중 팝업에서 Project/Description을 바꿔도 이미 시작된 다운로드의 저장 위치가 바뀌지 않는지**; **큰 MOV 다운로드 중 이미지 여러 장을 추가로 다운로드해 배치 토스트가 올바르게 집계되는지**; **팝업에서 Default Root를 변경(`sync-settings`)한 뒤 실제로 그 위치에 저장되는지, 그리고 Extension을 재시작해도(`get-settings`) 최신 Root가 미리보기에 반영되는지**.

## Q. 리스크 / 미확정 사항 (추측하지 않고 명시)

1. 실제 ChatGPT/Gemini 다운로드 동작에서 `chrome.downloads`가 보고하는 `url`/`finalUrl`/`referrer` 값(`blob:` URL vs 서명된 CDN URL vs 직접 네비게이션)은 아직 현재 사이트 동작 기준으로 검증되지 않았습니다.
2. `DownloadItem`에는 문서화된 탭 id 필드가 없으므로, intent-ping 상관관계(§F 3번)는 검증된 방식이 아니라 제안된 패턴입니다 — 일치하는 origin의 탭이 열려 있지만 유휴 상태이고 다른 곳에서 무관한 다운로드가 발생하면 오탐이 가능하며, 실증적으로 오탐/누락률을 측정해야 합니다.
3. ChatGPT/Gemini는 언제든 다운로드 메커니즘을 바꿀 수 있습니다(둘 다 활발히 개발 중) — 하나가 깨져도 다른 하나에 영향을 주지 않도록 adapter를 격리해야 하며, Extension 시작 시 가벼운 adapter self-check를 고려합니다.
4. Native Messaging host manifest의 `allowed_origins`는 특정 extension id에 고정됩니다 — 개발용 extension의 `"key"`를 초기에 고정해야 하며, 여러 Chrome 채널(Stable/Beta)이 설치된 환경에서의 등록도 필요시 재확인해야 합니다.
5. Agent를 단일 Node 실행 파일(Node SEA 또는 `pkg`)로 패키징하는 방식은 네이티브 애드온과 함께는 검증되지 않았습니다. Phase 1(순수 JS/JSON)에서는 문제없지만, Phase 3에서 `better-sqlite3`를 도입하기 전에 반드시 재검토해야 합니다.
6. 서명되지 않은 신규 Windows 실행 파일(Agent)은 첫 실행 시 SmartScreen 경고를 유발할 수 있습니다 — 개인/사내 MVP 용도로는 허용 가능하지만, 더 넓게 배포하기 전에 코드 서명 예산을 고려해야 합니다.
7. `chrome.downloads.erase`/`removeFile`이 `chrome://downloads` 히스토리에서 스테이징 파일 항목을 깔끔하게 제거하는지는 Phase 0에서 확인이 필요합니다("파일이 이동되었거나 없습니다" 같은 깨진 항목 방지).
8. `Settings.maxConcurrentFileOps`의 적정 기본값(현재 제안: 2)은 추측이며, 실제 NAS 장비/네트워크 환경에서 대용량 MOV 여러 개를 동시에 이동시켜 측정해야 합니다 — 로컬 드라이브와 NAS에 서로 다른 상한이 필요할 수 있습니다(§F-1, §O Phase 2).
9. Extension의 인메모리 Index 카운터와 디스크의 실제 상태가 어긋나는 경우(§F-1 Index Reservation) `get-max-index` 재조정으로 대부분 해소되지만, 재조정이 워크스페이스 컨텍스트 변경 시점에만 일어나므로 그 사이에 외부 프로세스가 같은 폴더에 파일을 추가하는 극단적 케이스는 여전히 Agent의 O_EXCL 충돌 suffix에 의존합니다 — 실사용 빈도가 무시할 만한지 Phase 1에서 관찰이 필요합니다.
10. §F-2에서 Root/FolderTemplate의 정본을 Agent로 옮기면서, 설치 직후 또는 Agent가 아직 한 번도 연결되지 않은 시점에 팝업이 표시할 `Settings` 캐시가 비어 있는 상태(cold start)가 생깁니다 — 이 경우 팝업이 "Agent에 연결해 설정을 불러오는 중" 같은 명확한 대기 상태를 보여줘야 하며, 빈 값이나 이전 값으로 미리보기를 잘못 표시하지 않도록 Phase 1 UI에서 반드시 처리해야 합니다.

## R. 최종 권장 사항 — 시작 순서

1. **Phase 0을 가장 먼저, 특히 위 1–2번 항목**(실제 ChatGPT + Gemini 다운로드 이벤트 로깅)부터: 소스 감지가 근본적으로 불안정하다고 판명되면 UI를 만들기 전에 제품 방향을 재검토해야 합니다.
2. **실제 대상 Windows 환경에서의 Native Messaging 왕복 검증**(레지스트리 + manifest + "hello world" host) — 두 번째로 확실치 않은 핵심 요소이자, Windows 환경에 특화된 함정이 가장 많이 나올 부분입니다.
3. 세 번째로 **`packages/shared`**를 만듭니다 — 순수 함수이고 어떤 OS에서든(Mac 포함) 완전히 단위 테스트 가능하며, 이후 두 컴포넌트가 공통으로 의존하는 기반입니다. **Index Reservation 카운터 로직(§F-1)도 이 단계에서 순수 함수로 만들고 동시 감지 시나리오를 단위 테스트로 고정합니다** — Chrome API 없이도 검증 가능하고, 나머지 파이프라인 전체가 이 로직의 정확성에 의존합니다.
4. 다음으로 **Agent의 job-queue(동시성 제한) + file-router(§F-2 `resolveSafeDestination` 포함) + file-mover**를 실제 목적지 폴더(로컬 디스크 + 매핑된 드라이브)에 대해 만듭니다 — Extension UI를 손대기 전입니다. "파일을 절대 잃어버리면 안 되는" 컴포넌트이자 "Root 밖으로 절대 쓰면 안 되는" 보안 경계이므로, Root Sandbox 검증과 junction 방어를 포함한 정확성·테스트를 사용자 대면 기능보다 먼저 확보하고, 이 시점에 동시 다운로드 시나리오(Failure Isolation 포함)로도 검증합니다.
5. 로컬 스텁 테스트 페이지를 대상으로 **Extension의 background 다운로드 파이프라인**을 엔드투엔드로 구축한 뒤, 실제 ChatGPT/Gemini adapter를 연결합니다.
6. **popup/options React UI**는 이미 동작하는 파이프라인 위에 마지막으로 얹습니다 — 가장 리스크가 낮고 반복 개발이 쉬운 부분이며, 그 아래 함수들이 정확하지 않으면 미리보기 자체가 의미 없습니다.
7. **실제 chatgpt.com/gemini.google.com adapter**는 추측이 아니라 Phase 0에서 얻은 실제 데이터를 기반으로 마지막에 연결합니다.

이 순서는 진짜로 불확실한 두 가지 기술적 베팅(소스 감지 신뢰성, Native Messaging 연동)에 UI 폴리싱보다 먼저 노력을 쏟고, "사용자 파일을 절대 잃지 않는다"는 컴포넌트의 정확성을 최우선으로 둡니다.

---

## 부록: 개발 환경(macOS) & Windows 배포 전략

사용자 확인 사항: **개발은 MacBook에서 진행하고, 최종 사용자/배포 대상은 Windows이며, 배포가 쉬운 형태여야 함.** 이는 위 계획 전반에 다음과 같이 반영되어 있습니다.

### 1. Mac에서 개발하고 Windows로 검증/배포하는 구조

| 컴포넌트 | Mac에서 개발 가능? | Windows 전용 검증이 필요한 부분 |
|---|---|---|
| `packages/shared` (순수 함수) | ✅ 완전히 가능, Vitest로 Mac에서 테스트 | 없음 |
| Extension UI (React) | ✅ 완전히 가능, Chrome은 Mac에서도 동일 엔진 | 실제 ChatGPT/Gemini 다운로드 이벤트 로깅(§O Phase 0)만 실제 사이트 접속 필요(OS 무관) |
| Agent 로직 (file-router, naming) | ✅ mock `fs`로 Mac에서 대부분 개발 가능 | 실제 Windows 경로 규칙(MAX_PATH, 예약어, 드라이브/UNC 타임아웃)은 Windows에서만 실증 가능 |
| **Native Messaging 레지스트리 등록** | ❌ macOS의 Native Messaging 레지스트리 위치/형식이 다름(`~/Library/...plist` vs Windows 레지스트리) | **반드시 실제 Windows 머신 또는 Windows VM/CI에서 검증** |
| 최종 `.exe` 실행 파일 동작 | ⚠️ 빌드는 Mac에서 가능(아래 참고)하지만 실행은 Windows에서만 | 실제 실행/설치 테스트는 Windows 필요 |

**권장 접근:** 로직(shared, agent 내부 함수)은 Mac에서 최대한 빠르게 반복 개발하고, "레지스트리/Native Messaging/실제 드라이브·NAS" 같은 Windows 전용 동작은 다음 두 가지 중 하나로 검증합니다.
- 가장 간단: 무료로 쓸 수 있는 Windows VM(예: Parallels/VMware의 평가판, 또는 클라우드 Windows 인스턴스) 하나를 "통합 테스트용"으로 유지.
- **추천:** 아래 CI 파이프라인으로 대체 — 로컬 Windows 머신을 상시 유지할 필요 없이 GitHub Actions의 `windows-latest` 러너가 대신 검증해 줍니다.

### 2. Agent 빌드: Mac에서 Windows용 실행 파일 크로스 컴파일

Node.js 20/24 기준으로, `pkg`(현재는 `yao-pkg` 포크가 유지보수됨)는 **Mac 호스트에서 Windows(win-x64) 바이너리를 크로스 컴파일**하는 것을 공식 지원합니다. ([yao-pkg 문서](https://yao-pkg.github.io/pkg/guide/getting-started)) 즉 Agent(Node.js/TypeScript)를 Mac에서 그대로 작성하고, 배포 시점에는 Mac에서 `pkg --target node-win-x64`류의 명령으로 `DownloadOrganizerAgent.exe`를 만들 수 있어 별도 Windows 빌드 머신이 필요 없습니다.

주의할 점(§Q 5와 연결): Phase 3에서 `better-sqlite3` 같은 네이티브 애드온을 도입하면 크로스 컴파일이 훨씬 까다로워지므로, 그 시점에는 GitHub Actions `windows-latest` 러너에서 네이티브 빌드하는 방식으로 전환하는 것을 전제로 합니다.

### 3. "쉬운 배포" — 설치 경험을 단순하게 만드는 두 축

**(1) Agent 설치 — 더블클릭 1회로 끝나는 Windows 인스톨러**
`pkg`로 만든 `.exe`와 `installer/install.ts`가 하는 일(레지스트리 키 + native-messaging manifest + 시작프로그램 바로가기)을 **Inno Setup**으로 하나의 설치 파일(`DownloadOrganizerSetup.exe`)로 묶습니다. Inno Setup 컴파일러 자체는 네이티브로는 Windows용이지만, `innosetup-compiler`라는 npm 패키지로 Wine을 통해 비-Windows에서도 실행 가능하고, 더 안정적으로는 GitHub Actions `windows-latest` 러너에서 빌드하면 됩니다. 최종 사용자(팀원 등)는 이 설치 파일 하나만 실행하면 Agent 설치·등록·자동 시작 등록까지 끝납니다 — Node.js나 개발 도구를 설치할 필요가 없습니다.

**(2) Extension 배포 — Developer Mode 없이 설치되는 방식**
사내/개인 도구 목적이라면 Chrome Web Store에 **"Unlisted"(링크를 아는 사람만 설치 가능, 검색 노출 없음)** 또는 **"Private"(Google Workspace 조직 내 지정 사용자만)** 형태로 등록하는 것을 권장합니다. 개발자 계정 등록비는 1회 5달러이며 이후 추가 확장 프로그램 게시에는 별도 비용이 없습니다. ([Chrome for Developers](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)) 이 방식이면 팀원들은 "Developer Mode 켜고 Load unpacked" 같은 개발자용 절차 없이 일반 확장 프로그램처럼 설치하고, 새 버전이 나오면 자동 업데이트됩니다. (완전히 개인 전용이라면 unpacked 폴더 배포로도 충분하며, 이 경우 Web Store 절차 자체를 생략할 수 있습니다.)

**(3) CI 파이프라인 (권장, `.github/workflows/windows-ci.yml`)**
- Push/PR 시: `packages/shared` 단위 테스트(Ubuntu/Mac 러너로 충분), Extension 빌드.
- `windows-latest` 러너에서: Agent 네이티브 통합 테스트(실제 임시 드라이브/폴더 대상), Native Messaging 등록 스크립트의 클린 설치/제거 검증.
- 릴리스 태그 시: `windows-latest` 러너에서 Inno Setup으로 `DownloadOrganizerSetup.exe`를 빌드해 GitHub Release에 첨부.

이 구조를 쓰면 개발자는 계속 Mac에서 작업하되, "실제로 Windows에서 동작하는가"라는 이 프로젝트에서 가장 중요한 질문에 대한 답을 CI가 매번 자동으로 확인해 주고, 최종 사용자에게는 인스톨러 더블클릭 + (선택) Web Store 링크 클릭 두 가지 동작만 남습니다.
