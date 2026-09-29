# MLB 순차 스크래핑 배포 설정

이 구현은 GitHub Pages에서 직접 스크래핑하지 않습니다. GitHub Actions가
Playwright 수집기를 실행하고, 완성된 표 단위 결과만 Supabase에 저장하며,
브라우저는 공개 읽기 키로 완성된 결과를 조회합니다.

과거 날짜를 선택하면 Supabase Edge Function이 큐 요청을 등록한 직후 GitHub
Actions의 `workflow_dispatch` API를 호출합니다. 기존 5분 스케줄은 즉시 호출이
실패했을 때 요청을 회수하는 안전장치로 유지합니다.

## 1. Supabase 테이블 생성

MLB용 Supabase 프로젝트의 **SQL Editor**에서 `supabase/schema.sql` 전체를
실행합니다. 이 SQL은 다음을 보장합니다.

- 브라우저는 `status = 'complete'`인 표만 읽을 수 있음
- 브라우저 키로 INSERT, UPDATE, DELETE 불가
- 실행 상태와 실패 원인은 공개되지 않음
- 같은 경기와 표는 새 수집 결과로 upsert됨

## 2. GitHub Pages 공개 설정

Supabase의 프로젝트 URL과 **publishable key**를 `supabase-config.js`에
입력합니다.

```javascript
window.MLB_SUPABASE_CONFIG = Object.freeze({
    url: 'https://프로젝트-ref.supabase.co',
    publishableKey: 'sb_publishable_...'
});
```

이 파일은 공개됩니다. `secret key`, `service_role` 키, 데이터베이스 비밀번호는
절대 넣지 않습니다.

## 3. GitHub Actions Secrets

저장소의 **Settings → Secrets and variables → Actions**에서 다음 Repository
secrets를 생성합니다.

- `SUPABASE_URL`: Supabase 프로젝트 URL
- `SUPABASE_SECRET_KEY`: 서버 전용 secret key

secret key는 GitHub Actions에서 Supabase에 쓰기 위해서만 사용하며 프런트엔드
파일에는 포함하지 않습니다.

## 4. 즉시 실행 Edge Function

1. GitHub에서 이 저장소만 선택한 fine-grained personal access token을 만들고,
   Repository permissions의 **Actions: Read and write**만 부여합니다.
2. Supabase **Edge Function Secrets**에 `GITHUB_WORKFLOW_TOKEN`이라는 이름으로
   토큰을 저장합니다.
3. `request-mlb-scrape` Edge Function을 배포합니다. 함수 설정은
   `supabase/config.toml`에 있으며 공개 키를 함수 내부에서 다시 검증합니다.

GitHub 토큰은 Supabase 서버에서만 읽으며 GitHub Pages나 브라우저 응답에는
포함되지 않습니다. 같은 날짜를 반복 클릭해도 SQL 함수의 `shouldDispatch` 값이
처음 등록되거나 30분 뒤 재시도되는 요청에만 true가 되어 중복 실행을 막습니다.

## 5. 순차 실행 규칙

`.github/workflows/scrape.yml`은 매일 한국시간 18:17에 실행되어 다음 날 경기를
준비합니다. Actions의 **Run workflow**에서 날짜를 입력해 수동 실행할 수도
있습니다.

경기마다 아래 순서를 엄격히 지킵니다.

1. `starterH2H`
2. `starterRecent`
3. `highLevH2H`
4. `highLevRecent`
5. `midLevH2H`
6. `midLevRecent`
7. `lowLevH2H`
8. `lowLevRecent`
9. `unplayablePitchers`
10. `hittingRecent`

각 단계는 원정팀과 홈팀 수집, 결과 검증, Supabase 저장까지 완료한 후 다음
단계로 이동합니다. 한 단계라도 실패하면 이후 표는 실행하지 않고
`mlb_scrape_runs`에 실패 원인을 기록합니다. 빈 선수 목록은 정상적인 완성 결과로
저장하지만, 예고 선발이 없거나 필수 선발 통계를 찾지 못하면 실패 처리합니다.

## 6. 첫 실행 확인

1. Actions에서 `Scrape MLB tables sequentially`를 선택합니다.
2. **Run workflow**를 누르고 `YYYY-MM-DD` 경기 날짜를 입력합니다.
3. 로그에서 표가 `01/10`부터 `10/10`까지 순서대로 완료되는지 확인합니다.
4. Supabase Table Editor에서 `mlb_game_table_snapshots`에 경기당 10행이 있는지
   확인합니다.
5. GitHub Pages에서 경기를 선택하고 `10개 표 로드 완료` 메시지를 확인합니다.
