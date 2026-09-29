const MLB_SCHEDULE_API_URL = 'https://statsapi.mlb.com/api/v1/schedule';
const MLB_TABLE_IDS = Object.freeze({
    starterH2H: 'starterH2H',
    starterRecent: 'starterRecent',
    highLevH2H: 'highLevH2H',
    highLevRecent: 'highLevRecent',
    midLevH2H: 'midLevH2H',
    midLevRecent: 'midLevRecent',
    lowLevH2H: 'lowLevH2H',
    lowLevRecent: 'lowLevRecent',
    unplayablePitchers: 'unplayablePitchers',
    hittingRecent: 'hittingRecent'
});

const MLB_SNAPSHOT_TABLE_ORDER = Object.freeze([
    'starterH2H',
    'starterRecent',
    'highLevH2H',
    'highLevRecent',
    'midLevH2H',
    'midLevRecent',
    'lowLevH2H',
    'lowLevRecent',
    'unplayablePitchers',
    'hittingRecent'
]);

function formatMLBScheduleDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getMLBSchedulePageUrl(date) {
    return `https://www.mlb.com/schedule/${formatMLBScheduleDate(date)}`;
}

function parseMLBScheduleGame(game, dateString) {
    const away = game.teams?.away;
    const home = game.teams?.home;

    return {
        gamePk: game.gamePk,
        date: dateString,
        gameDate: game.gameDate,
        gameNumber: game.gameNumber,
        status: game.status?.detailedState || '',
        away: away?.team?.abbreviation || '',
        home: home?.team?.abbreviation || '',
        awayName: away?.team?.name || '',
        homeName: home?.team?.name || '',
        awayStarter: away?.probablePitcher?.fullName || '',
        homeStarter: home?.probablePitcher?.fullName || '',
        awayStarterId: away?.probablePitcher?.id || null,
        homeStarterId: home?.probablePitcher?.id || null,
        sourceUrl: `https://www.mlb.com/schedule/${dateString}`
    };
}

async function getGamesForDate(date) {
    const dateString = formatMLBScheduleDate(date);
    const params = new URLSearchParams({
        sportId: '1',
        date: dateString,
        hydrate: 'probablePitcher(note),team'
    });
    const response = await fetch(`${MLB_SCHEDULE_API_URL}?${params.toString()}`, {
        cache: 'no-store',
        headers: { Accept: 'application/json' }
    });

    if (!response.ok) {
        throw new Error(`MLB 일정 요청 실패 (${response.status})`);
    }

    const data = await response.json();
    const scheduleDate = (data.dates || []).find(item => item.date === dateString);
    return (scheduleDate?.games || [])
        .map(game => parseMLBScheduleGame(game, dateString))
        .filter(game => game.away && game.home);
}

class MLBFrontend {
    constructor() {
        this.currentDate = new Date();
        this.comparisonChart = null;
        this.chartTooltip = null;
        this.battingComparisonChart = null;
        this.battingChartTooltip = null;
        this.calendarDate = new Date(this.currentDate);
        this.calendarVisible = false;
        this.selectedGame = null;
        this.currentGames = [];
        this.gamesLoadSequence = 0;
        this.snapshotLoadSequence = 0;
        this.snapshotPollTimer = null;
        this.scrapeRequestPromises = new Map();
        this.currentPage = 0; // 현재 페이지 인덱스 (0부터 시작: 0=첫번째 페이지, 1=두번째 페이지, 2=세번째 페이지)
        this.gamesPerPage = 5; // 한 페이지당 표시할 게임 수
        this.totalGames = 0; // 전체 게임 수 (현재 날짜의 총 경기 개수)
        this.battingStatsData = null; // 타격 성적 데이터 저장
        this.tables = {};
        
        // 팀명 데이터
        this.teamNames = {
            'ATH': 'Athletics',
            'ATL': 'Atlanta Braves',
            'AZ': 'Arizona Diamondbacks',
            'BAL': 'Baltimore Orioles',
            'BOS': 'Boston Red Sox',
            'CHC': 'Chicago Cubs',
            'CIN': 'Cincinnati Reds',
            'CLE': 'Cleveland Guardians',
            'COL': 'Colorado Rockies',
            'CWS': 'Chicago White Sox',
            'DET': 'Detroit Tigers',
            'HOU': 'Houston Astros',
            'KC': 'Kansas City Royals',
            'LAA': 'Los Angeles Angels',
            'LAD': 'Los Angeles Dodgers',
            'MIA': 'Miami Marlins',
            'MIL': 'Milwaukee Brewers',
            'MIN': 'Minnesota Twins',
            'NYM': 'New York Mets',
            'NYY': 'New York Yankees',
            'PHI': 'Philadelphia Phillies',
            'PIT': 'Pittsburgh Pirates',
            'SD': 'San Diego Padres',
            'SEA': 'Seattle Mariners',
            'SF': 'San Francisco Giants',
            'STL': 'St. Louis Cardinals',
            'TB': 'Tampa Bay Rays',
            'TEX': 'Texas Rangers',
            'TOR': 'Toronto Blue Jays',
            'WSH': 'Washington Nationals'
        };
        
        // 팀명 약칭 매핑 (JSON 데이터의 약칭을 프론트엔드 약칭으로 변환)
        this.teamAbbreviationMap = {
            'AZ': 'ARI',
            'CWS': 'CHW',
            'KC': 'KCR',
            'SD': 'SDP',
            'SF': 'SFG',
            'TB': 'TBR',
            'WSH': 'WSN'
        };
        
        this.init();
        this.initComparisonChart();
        this.initBattingComparisonChart();
    }
    
    // 비교 차트 초기화
    initComparisonChart() {
        this.chartTooltip = document.getElementById('comparisonChartTooltip');
        if (!this.chartTooltip) return;
        
        const startingPitcherTable = document.getElementById(MLB_TABLE_IDS.starterH2H);
        if (!startingPitcherTable) return;
        
        const headers = startingPitcherTable.querySelectorAll('thead th.chart-hoverable');
        headers.forEach(header => {
            // 기존 이벤트 리스너 제거 (중복 방지)
            header.removeEventListener('mouseenter', this._chartMouseEnterHandler);
            header.removeEventListener('mouseleave', this._chartMouseLeaveHandler);
            
            // 새 이벤트 핸들러 생성 및 저장
            this._chartMouseEnterHandler = (e) => {
                const statName = header.getAttribute('data-stat');
                this.showComparisonChartFromElement(header, statName);
            };
            this._chartMouseLeaveHandler = () => this.hideComparisonChart();
            
            header.addEventListener('mouseenter', this._chartMouseEnterHandler);
            header.addEventListener('mouseleave', this._chartMouseLeaveHandler);
        });
        
        // tbody 셀에도 동일한 인터랙션 제공 (이벤트 위임)
        const tbody = startingPitcherTable.querySelector('tbody');
        if (tbody) {
            if (this._chartBodyEnterHandler) {
                tbody.removeEventListener('mouseover', this._chartBodyEnterHandler);
            }
            if (this._chartBodyLeaveHandler) {
                tbody.removeEventListener('mouseleave', this._chartBodyLeaveHandler);
            }
            
            this._chartBodyEnterHandler = (e) => {
                const cell = e.target.closest('td');
                if (!cell) return;
                
                const row = cell.parentElement;
                const cellIndex = Array.from(row.cells).indexOf(cell);
                if (cellIndex < 0) return;
                
                const headerList = startingPitcherTable.querySelectorAll('thead th');
                const header = headerList[cellIndex];
                const statName = header ? header.getAttribute('data-stat') : null;
                
                if (!statName || statName === 'Team' || statName === 'Name') return;
                
                this.showComparisonChartFromElement(cell, statName);
            };
            
            this._chartBodyLeaveHandler = () => this.hideComparisonChart();
            
            tbody.addEventListener('mouseover', this._chartBodyEnterHandler);
            tbody.addEventListener('mouseleave', this._chartBodyLeaveHandler);
        }
    }
    
    // 타격 성적 차트 초기화
    initBattingComparisonChart() {
        this.battingChartTooltip = document.getElementById('battingChartTooltip');
        if (!this.battingChartTooltip) return;
        
        const battingStatsTable = document.getElementById(MLB_TABLE_IDS.hittingRecent);
        if (!battingStatsTable) return;
        
        const headers = battingStatsTable.querySelectorAll('thead th.chart-hoverable');
        headers.forEach(header => {
            // 기존 이벤트 리스너 제거 (중복 방지)
            header.removeEventListener('mouseenter', this._battingChartMouseEnterHandler);
            header.removeEventListener('mouseleave', this._battingChartMouseLeaveHandler);
            
            // 새 이벤트 핸들러 생성 및 저장
            this._battingChartMouseEnterHandler = (e) => {
                const statName = header.getAttribute('data-stat');
                this.showBattingComparisonChartFromElement(header, statName);
            };
            this._battingChartMouseLeaveHandler = () => this.hideBattingComparisonChart();
            
            header.addEventListener('mouseenter', this._battingChartMouseEnterHandler);
            header.addEventListener('mouseleave', this._battingChartMouseLeaveHandler);
        });
        
        // tbody 셀에도 동일한 인터랙션 제공 (이벤트 위임)
        const tbody = battingStatsTable.querySelector('tbody');
        if (tbody) {
            if (this._battingChartBodyEnterHandler) {
                tbody.removeEventListener('mouseover', this._battingChartBodyEnterHandler);
            }
            if (this._battingChartBodyLeaveHandler) {
                tbody.removeEventListener('mouseleave', this._battingChartBodyLeaveHandler);
            }
            
            this._battingChartBodyEnterHandler = (e) => {
                const cell = e.target.closest('td');
                if (!cell) return;
                
                const row = cell.parentElement;
                const cellIndex = Array.from(row.cells).indexOf(cell);
                if (cellIndex < 0) return;
                
                const headerList = battingStatsTable.querySelectorAll('thead th');
                const header = headerList[cellIndex];
                const statName = header ? header.getAttribute('data-stat') : null;
                
                if (!statName || statName === 'Team') return;
                
                this.showBattingComparisonChartFromElement(cell, statName);
            };
            
            this._battingChartBodyLeaveHandler = () => this.hideBattingComparisonChart();
            
            tbody.addEventListener('mouseover', this._battingChartBodyEnterHandler);
            tbody.addEventListener('mouseleave', this._battingChartBodyLeaveHandler);
        }
    }
    
    // 비교 차트 표시 (모든 통계를 한 번에) - 헤더/바디 공용
    showComparisonChartFromElement(targetEl, statName) {
        if (!targetEl || !statName || statName === 'Team' || statName === 'Name') return;
        
        const startingPitcherTable = document.getElementById(MLB_TABLE_IDS.starterH2H);
        const tbody = startingPitcherTable ? startingPitcherTable.querySelector('tbody') : null;
        const rows = tbody ? tbody.querySelectorAll('tr') : [];
        
        if (rows.length < 2) return;
        
        // 두 투수의 데이터 가져오기
        const awayRow = rows[0];
        const homeRow = rows[1];
        
        const awayName = awayRow.cells[1] ? awayRow.cells[1].textContent.trim() : '';
        const homeName = homeRow.cells[1] ? homeRow.cells[1].textContent.trim() : '';
        
        if (!awayName || !homeName) return;
        
        // 모든 통계 헤더 가져오기
        const headers = startingPitcherTable.querySelectorAll('thead th.chart-hoverable');
        const stats = [];
        const awayValues = [];
        const homeValues = [];
        
        headers.forEach((header) => {
            const stat = header.getAttribute('data-stat');
            if (!stat) return;
            
            // 헤더 인덱스 찾기 (Team, Name 제외)
            const headerIndex = Array.from(startingPitcherTable.querySelectorAll('thead th')).indexOf(header);
            
            const awayValue = awayRow.cells[headerIndex] ? awayRow.cells[headerIndex].textContent.trim() : '';
            const homeValue = homeRow.cells[headerIndex] ? homeRow.cells[headerIndex].textContent.trim() : '';
            
            if (awayValue && homeValue) {
                const awayNum = parseFloat(awayValue);
                const homeNum = parseFloat(homeValue);
                
                if (!isNaN(awayNum) && !isNaN(homeNum)) {
                    stats.push(stat);
                    awayValues.push(awayNum);
                    homeValues.push(homeNum);
                }
            }
        });
        
        if (stats.length === 0) return;
        
        // 차트 위치 설정 (헤더/셀 공용)
        const rect = targetEl.getBoundingClientRect();
        this.chartTooltip.style.display = 'block';
        this.chartTooltip.style.position = 'fixed';
        this.chartTooltip.style.left = `${rect.left + rect.width / 2}px`;
        this.chartTooltip.style.top = `${rect.bottom + 10}px`;
        this.chartTooltip.style.transform = 'translateX(-50%)';
        
        // 차트 생성 (모든 통계)
        this.createComparisonChart(stats, awayName, homeName, awayValues, homeValues);
    }
    
    // 비교 차트 생성 (모든 통계)
    createComparisonChart(stats, awayName, homeName, awayValues, homeValues) {
        const canvas = document.getElementById('comparisonChart');
        if (!canvas) return;
        
        // 기존 차트가 있으면 제거
        if (this.comparisonChart) {
            this.comparisonChart.destroy();
        }
        
        // 각 통계별로 값 정규화 (합이 100이 되도록)
        const awayPercents = [];
        const homePercents = [];
        const originalAwayValues = [];
        const originalHomeValues = [];
        
        stats.forEach((stat, index) => {
            const awayValue = awayValues[index];
            const homeValue = homeValues[index];
            const total = awayValue + homeValue;
            
            const awayPercent = total > 0 ? (awayValue / total) * 100 : 50;
            const homePercent = total > 0 ? (homeValue / total) * 100 : 50;
            
            awayPercents.push(awayPercent);
            homePercents.push(homePercent);
            originalAwayValues.push(awayValue);
            originalHomeValues.push(homeValue);
        });
        
        // 차트 생성
        const ctx = canvas.getContext('2d');
        this.comparisonChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: stats,
                datasets: [
                    {
                        label: awayName,
                        data: awayPercents,
                        backgroundColor: 'rgba(255, 159, 64, 0.8)',
                        borderColor: 'rgba(255, 159, 64, 1)',
                        borderWidth: 1
                    },
                    {
                        label: homeName,
                        data: homePercents,
                        backgroundColor: 'rgba(128, 0, 128, 0.8)',
                        borderColor: 'rgba(128, 0, 128, 1)',
                        borderWidth: 1
                    }
                ]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: true,
                        position: 'top'
                    },
                    tooltip: {
                        callbacks: {
                            label: (context) => {
                                const datasetIndex = context.datasetIndex;
                                const dataIndex = context.dataIndex;
                                const percent = context.dataset.data[dataIndex];
                                const originalValue = datasetIndex === 0 
                                    ? originalAwayValues[dataIndex] 
                                    : originalHomeValues[dataIndex];
                                const statName = stats[dataIndex];
                                
                                // 통계에 따라 소수점 자리수 조정
                                let formattedValue;
                                if (statName === 'G' || statName === 'IP') {
                                    formattedValue = originalValue.toFixed(1);
                                } else {
                                    formattedValue = originalValue.toFixed(3);
                                }
                                
                                return `${context.dataset.label}: ${formattedValue} (${percent.toFixed(1)}%)`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        stacked: true,
                        max: 100,
                        ticks: {
                            callback: function(value) {
                                return value + '%';
                            }
                        }
                    },
                    y: {
                        stacked: true
                    }
                }
            }
        });
    }
    
    // 비교 차트 숨기기
    hideComparisonChart() {
        if (this.chartTooltip) {
            this.chartTooltip.style.display = 'none';
        }
        if (this.comparisonChart) {
            this.comparisonChart.destroy();
            this.comparisonChart = null;
        }
    }
    
    // 팀명 약칭 변환 함수 (JSON 데이터의 약칭을 프론트엔드 약칭으로 변환)
    normalizeTeamAbbreviation(teamAbbr) {
        if (!teamAbbr) return teamAbbr;
        // 매핑에 있으면 변환, 없으면 그대로 반환
        return this.teamAbbreviationMap[teamAbbr] || teamAbbr;
    }
    
    // 팀명 약칭 비교 함수 (양방향 비교)
    compareTeamAbbreviations(team1, team2) {
        if (!team1 || !team2) return false;
        const normalized1 = this.normalizeTeamAbbreviation(team1);
        const normalized2 = this.normalizeTeamAbbreviation(team2);
        return normalized1 === normalized2 || team1 === team2;
    }
    
    init() {
        this.tables = Object.fromEntries(
            Object.entries(MLB_TABLE_IDS).map(([name, id]) => [name, document.getElementById(id)])
        );
        Object.assign(this, this.tables);
        this.bindEvents();
        this.updateDateDisplay();
        this.loadGamesForCurrentDate();
        this.initializeGameSelection();
        this.initializePagination();
        this.mergeTeamCells();
    }
    
    bindEvents() {
        // 달력 외부 클릭 시 닫기
        document.addEventListener('click', (event) => {
            const calendarContainer = document.getElementById('calendarContainer');
            const dateDisplay = document.querySelector('.date-display');
            
            if (this.calendarVisible && 
                !calendarContainer.contains(event.target) && 
                !dateDisplay.contains(event.target)) {
                this.calendarVisible = false;
                calendarContainer.style.display = 'none';
            }
            
            // 투수 드롭다운 외부 클릭 시 닫기
            const pitcherDropdowns = document.querySelectorAll('.pitcher-dropdown');
            const pitcherBoxes = document.querySelectorAll('.pitcher-box');
            
            pitcherDropdowns.forEach((dropdown, index) => {
                const pitcherBox = pitcherBoxes[index];
                if (dropdown.style.display === 'block' && 
                    !dropdown.contains(event.target) && 
                    !pitcherBox.contains(event.target)) {
                    dropdown.style.display = 'none';
                }
            });
        });
    }
    
    // 1. changeDate() 함수들 (HTML 17, 19번째 줄에서 사용)
    changeDate(direction) {
        this.currentDate.setDate(this.currentDate.getDate() + direction);
        this.updateDateDisplay();
        this.loadGamesForCurrentDate({ queueIfMissing: true });
        if (this.calendarVisible) {
            this.calendarDate = new Date(this.currentDate);
            this.renderCalendar();
        }
    }
    
    updateDateDisplay() {
        const year = this.currentDate.getFullYear();
        const month = this.currentDate.getMonth() + 1;
        const date = this.currentDate.getDate();
        const dayNames = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
        const dayName = dayNames[this.currentDate.getDay()];
        
        const dateDisplay = document.querySelector('.date-display');
        if (dateDisplay) {
            dateDisplay.textContent = `${year}년 ${month}월 ${date}일 ${dayName}`;
            dateDisplay.dataset.date = this.formatDateForAPI(this.currentDate);
            dateDisplay.dataset.mlbScheduleUrl = getMLBSchedulePageUrl(this.currentDate);
            dateDisplay.title = `MLB 일정 출처: ${dateDisplay.dataset.mlbScheduleUrl}`;
        }
    }
    
    selectDate(date) {
        this.currentDate = new Date(date);
        this.updateDateDisplay();
        this.loadGamesForCurrentDate({ queueIfMissing: true });
        this.calendarVisible = false;
        const calendarContainer = document.getElementById('calendarContainer');
        if (calendarContainer) {
            calendarContainer.style.display = 'none';
        }
    }
    
    // 2. toggleCalendar() 함수 (HTML 18번째 줄에서 사용)
    toggleCalendar() {
        const calendarContainer = document.getElementById('calendarContainer');
        this.calendarVisible = !this.calendarVisible;
        
        if (this.calendarVisible) {
            this.calendarDate = new Date(this.currentDate);
            this.renderCalendar();
            if (calendarContainer) {
                calendarContainer.style.display = 'block';
            }
        } else {
            if (calendarContainer) {
                calendarContainer.style.display = 'none';
            }
        }
    }
    
    // 3. changeMonth() 함수들 (HTML 24, 26번째 줄에서 사용)
    changeMonth(direction) {
        this.calendarDate.setMonth(this.calendarDate.getMonth() + direction);
        this.renderCalendar();
    }
    
    renderCalendar() {
        const year = this.calendarDate.getFullYear();
        const month = this.calendarDate.getMonth();
        const monthNames = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'];
        
        const monthYearElement = document.getElementById('calendarMonthYear');
        if (monthYearElement) {
            monthYearElement.textContent = `${year}년 ${monthNames[month]}`;
        }
        
        const firstDay = new Date(year, month, 1);
        const startDate = new Date(firstDay);
        startDate.setDate(startDate.getDate() - firstDay.getDay());
        
        const calendarDays = document.getElementById('calendarDays');
        if (!calendarDays) return;
        
        calendarDays.innerHTML = '';
        
        const today = new Date();
        const selectedDate = new Date(this.currentDate);
        
        for (let i = 0; i < 42; i++) {
            const date = new Date(startDate);
            date.setDate(startDate.getDate() + i);
            
            const dayElement = document.createElement('div');
            dayElement.className = 'calendar-day';
            dayElement.textContent = date.getDate();
            
            if (date.getMonth() !== month) {
                dayElement.classList.add('other-month');
            }
            
            if (date.toDateString() === today.toDateString()) {
                dayElement.classList.add('today');
            }
            
            if (date.toDateString() === selectedDate.toDateString()) {
                dayElement.classList.add('selected');
            }
            
            dayElement.onclick = () => this.selectDate(date);
            calendarDays.appendChild(dayElement);
        }
    }
    
    // 4. selectGame() 함수들 (HTML 47~61번째 줄에서 사용)
    selectGame(gameBox, gameIndex) {
        // 모든 게임 박스에서 selected 클래스 제거
        const allGameBoxes = document.querySelectorAll('.game-box');
        allGameBoxes.forEach(box => {
            box.classList.remove('selected');
        });
        
        // 선택된 게임 박스에 selected 클래스 추가
        gameBox.classList.add('selected');
        this.selectedGame = gameIndex;
        
        // 경기 정보 업데이트 (더블헤더도 경기 인덱스로 정확히 구분)
        this.updateGameDetails(gameIndex);
        
        console.log(`Selected game: ${gameBox.textContent}`);
    }
    
    updateGameDetails(gameIndex) {
        const selectedGame = this.currentGames[gameIndex];
        if (selectedGame) {
            const awayTeamCode = selectedGame.away;
            const homeTeamCode = selectedGame.home;
            
            // 팀명 가져오기 (스케줄 데이터 우선, 없으면 기본 팀명 사용)
            const awayTeamName = selectedGame ? selectedGame.awayName : (this.teamNames[awayTeamCode] || awayTeamCode);
            const homeTeamName = selectedGame ? selectedGame.homeName : (this.teamNames[homeTeamCode] || homeTeamCode);
            
            // DOM 요소 업데이트
            const awayTeamBox = document.getElementById('awayTeamBox');
            const homeTeamBox = document.getElementById('homeTeamBox');
            
            if (awayTeamBox) {
                awayTeamBox.textContent = awayTeamName;
            }
            if (homeTeamBox) {
                homeTeamBox.textContent = homeTeamName;
            }
            
            // 경기 선택 시 테이블 비우기 (동적으로 데이터 채워짐)
            this.clearAllTables();

            // MLB 일정 데이터의 경기별 예고 선발을 표시하고 드롭다운 맨 앞에 배치
            this.updatePitcherDropdowns(awayTeamCode, homeTeamCode, selectedGame);

            // 세 개의 선발투수 표에 원정팀/홈팀과 선발투수를 같은 순서로 표시
            this.updateStartingPitcherTable();
            this.setStarterStatsVisibility(true);

            // GitHub Actions가 순서대로 완성해 둔 Supabase 스냅샷을 읽는다.
            void this.loadGameSnapshot(selectedGame);
            
            console.log(`Updated teams: ${awayTeamName} vs ${homeTeamName}`);
        }
    }
    
    // 공식 일정 데이터에 등록된 예고 선발만 사용한다.
    updatePitcherDropdowns(awayTeamCode, homeTeamCode, game) {
        const awayPitchers = game.awayStarter ? [game.awayStarter] : [];
        const homePitchers = game.homeStarter ? [game.homeStarter] : [];
        const awayStarter = game.awayStarter || '';
        const homeStarter = game.homeStarter || '';

        this.updatePitcherInfo('away', awayStarter, awayPitchers);
        this.updatePitcherInfo('home', homeStarter, homePitchers);
    }
    
    // 5. togglePitcherDropdown() 함수들 (HTML 77, 91번째 줄에서 사용)
    togglePitcherDropdown(team) {
        const dropdownId = team === 'away' ? 'awayPitcherDropdown' : 'homePitcherDropdown';
        const dropdown = document.getElementById(dropdownId);
        
        if (dropdown) {
            const isVisible = dropdown.style.display === 'block';
            
            // 모든 드롭다운 닫기
            document.querySelectorAll('.pitcher-dropdown').forEach(dd => {
                dd.style.display = 'none';
            });
            
            // 클릭한 드롭다운만 토글
            if (!isVisible) {
                dropdown.style.display = 'block';
            }
        }
    }
    
    // 6. selectPitcher() 함수들 (HTML 79~83, 93~97번째 줄에서 사용)
    selectPitcher(team, pitcherName) {
        const pitcherBox = team === 'away' ? 
            document.querySelector('.team-section:first-child .pitcher-box') :
            document.querySelector('.team-section:last-child .pitcher-box');
        
        if (pitcherBox) {
            pitcherBox.textContent = pitcherName;
        }
        
        // 드롭다운 닫기
        const dropdownId = team === 'away' ? 'awayPitcherDropdown' : 'homePitcherDropdown';
        const dropdown = document.getElementById(dropdownId);
        if (dropdown) {
            dropdown.style.display = 'none';
        }
        
        // 선발투수 테이블 업데이트
        this.updateStartingPitcherTable();
        
        // 양 팀 투수 선택 완료 시 테이블 표시
        this.checkPitcherSelection();
        
        console.log(`Selected ${team} pitcher: ${pitcherName}`);
    }
    
    setStarterStatsVisibility(isVisible) {
        document.querySelectorAll('.starter-stats-container').forEach(section => {
            section.style.display = isVisible ? 'block' : 'none';
        });
    }

    // 세 개의 선발투수 표에 팀명과 투수명을 동일하게 업데이트
    updateStartingPitcherTable() {
        const gameBoxSelected = document.querySelector('.game-box.selected');
        const awayPitcherBox = document.getElementById('awayPitcherBox');
        const homePitcherBox = document.getElementById('homePitcherBox');
        const selectedGame = this.currentGames[this.selectedGame];
        
        if (!gameBoxSelected || !selectedGame) {
            return;
        }
        
        // game-box selected에서 팀 코드 추출 ("팀코드 vs 팀코드" 형식)
        const awayTeamCode = gameBoxSelected.dataset.awayTeam || '';
        const homeTeamCode = gameBoxSelected.dataset.homeTeam || '';

        if (!awayTeamCode || !homeTeamCode) return;
        
        // 투수 이름 가져오기
        const awayPitcher = selectedGame.awayStarter || '';
        const homePitcher = selectedGame.homeStarter || '';
        
        const tableIds = [MLB_TABLE_IDS.starterH2H, MLB_TABLE_IDS.starterRecent];
        const starters = [
            { team: awayTeamCode, name: awayPitcher },
            { team: homeTeamCode, name: homePitcher }
        ];

        tableIds.forEach(tableId => {
            const table = document.getElementById(tableId);
            if (!table) return;

            let tbody = table.querySelector('tbody');
            if (!tbody) {
                tbody = document.createElement('tbody');
                table.appendChild(tbody);
            }
            tbody.innerHTML = '';

            const columnCount = table.querySelectorAll('thead th').length || 11;
            starters.forEach(starter => {
                const row = document.createElement('tr');
                for (let index = 0; index < columnCount; index++) {
                    const cell = document.createElement('td');
                    if (index === 0) {
                        cell.className = 'team-cell';
                        cell.textContent = starter.team;
                    } else if (index === 1) {
                        cell.className = 'name-cell';
                        cell.textContent = starter.name;
                    }
                    row.appendChild(cell);
                }
                tbody.appendChild(row);
            });
        });
        
        // 차트 이벤트 리스너 재설정 (테이블 업데이트 후)
        setTimeout(() => {
            this.initComparisonChart();
        }, 100);
    }
    
    // 양 팀 투수 선택 상태 확인 및 스크래핑 요청
    async checkPitcherSelection() {
        const awayPitcherBox = document.getElementById('awayPitcherBox');
        const homePitcherBox = document.getElementById('homePitcherBox');
        const statsSections = document.querySelectorAll('.starter-stats-container');
        
        if (awayPitcherBox && homePitcherBox && statsSections.length > 0) {
            const awayPitcher = awayPitcherBox.textContent.trim();
            const homePitcher = homePitcherBox.textContent.trim();
            
            // 양 팀 모두 선발투수가 선택되었는지 확인
            const isAwaySelected = awayPitcher !== '선발투수 선택' && awayPitcher !== '선발투수 미정' && awayPitcher !== '';
            const isHomeSelected = homePitcher !== '선발투수 선택' && homePitcher !== '선발투수 미정' && homePitcher !== '';
            
            if (isAwaySelected && isHomeSelected) {
                this.setStarterStatsVisibility(true);
                
                // 양 팀 투수가 모두 선택되었으므로 서버에 스크래핑 요청
                await this.scrapePitcherStats(awayPitcher, homePitcher);
            } else {
                this.setStarterStatsVisibility(false);
            }
        }
    }
    
    // 서버에 투수 통계 스크래핑 요청
    async scrapePitcherStats(awayPitcherName, homePitcherName) {
        const gameBoxSelected = document.querySelector('.game-box.selected');
        if (!gameBoxSelected) {
            return;
        }
        
        // 게임 박스에 저장한 팀 코드를 사용한다.
        const awayTeamCode = gameBoxSelected.dataset.awayTeam || '';
        const homeTeamCode = gameBoxSelected.dataset.homeTeam || '';
        
        // 현재 날짜를 YYYY-MM-DD 형식으로 가져오기
        const gameDate = this.formatDateForAPI(this.currentDate);
        
        console.log(`Scraping stats for pitchers: ${awayPitcherName} and ${homePitcherName} on ${gameDate}`);
        
        // 선택된 날짜 (YYYY-MM-DD) 전달
        const selectedDate = this.formatDateForAPI(this.currentDate);
        
        // Python 스크래퍼를 실행하여 JSON 파일 생성
        await this.runScraperAndLoadData(selectedDate, awayPitcherName, homePitcherName, awayTeamCode, homeTeamCode);
    }
    
    // 날짜 계산: 선택된 날짜 - 30일 (startDate, 30일 전)
    calculateStartDate(selectedDate) {
        const date = new Date(selectedDate);
        date.setDate(date.getDate() - 30);
        return this.formatDateForAPI(date);
    }

    // 날짜 계산: 선택된 날짜 - 1일 (endDate, 하루 전)
    calculateEndDate(selectedDate) {
        const date = new Date(selectedDate);
        date.setDate(date.getDate() - 1);
        return this.formatDateForAPI(date);
    }
    
    getSupabaseConfig() {
        const config = window.MLB_SUPABASE_CONFIG || {};
        const url = String(config.url || '').replace(/\/$/, '');
        const publishableKey = String(config.publishableKey || '');
        const isPlaceholder = !url
            || !publishableKey
            || url.includes('YOUR_PROJECT_REF')
            || publishableKey.includes('YOUR_SUPABASE_PUBLISHABLE_KEY');
        return isPlaceholder ? null : { url, publishableKey };
    }

    setDataStatus(message, isError = false) {
        const status = document.getElementById('dataStatus');
        if (!status) return;
        status.textContent = message;
        status.classList.toggle('error', isError);
    }

    isScrapeRequestDateAllowed(dateString) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateString || ''))) return false;
        const selected = new Date(`${dateString}T00:00:00`);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const oldest = new Date(today);
        oldest.setDate(oldest.getDate() - 400);
        return selected >= oldest && selected <= today;
    }

    async requestScrapeForDate(dateString) {
        if (this.scrapeRequestPromises.has(dateString)) {
            return await this.scrapeRequestPromises.get(dateString);
        }

        const requestPromise = (async () => {
            const config = this.getSupabaseConfig();
            if (!config) {
                throw new Error('supabase-config.js에 프로젝트 URL과 publishable key를 설정해야 합니다.');
            }
            const response = await fetch(
                `${config.url}/functions/v1/request-mlb-scrape`,
                {
                    method: 'POST',
                    cache: 'no-store',
                    headers: {
                        Accept: 'application/json',
                        'Content-Type': 'application/json',
                        apikey: config.publishableKey
                    },
                    body: JSON.stringify({ p_selected_date: dateString })
                }
            );
            if (!response.ok) {
                const detail = await response.text();
                throw new Error(`수집 요청 등록 실패 (${response.status}): ${detail}`);
            }
            return await response.json();
        })();

        this.scrapeRequestPromises.set(dateString, requestPromise);
        try {
            return await requestPromise;
        } finally {
            this.scrapeRequestPromises.delete(dateString);
        }
    }

    describeScrapeRequest(request) {
        if (request && request.dispatchStatus === 'started') {
            return '이 날짜 전체 경기 수집을 즉시 시작했습니다.';
        }
        if (request && request.dispatchStatus === 'fallback') {
            return '수집 요청을 등록했습니다. 즉시 호출이 지연되어 5분 주기로 자동 재확인합니다.';
        }
        if (request && request.status === 'running') {
            return '이 날짜 전체 경기를 이미 수집 중입니다.';
        }
        if (request && request.status === 'failed') {
            return '최근 수집 요청이 실패했습니다. 30분 후 날짜를 다시 선택하면 재시도합니다.';
        }
        if (request && request.status === 'complete') {
            return '이 날짜의 최근 수집 요청은 완료됐습니다.';
        }
        return '이 날짜 전체 경기의 수집 요청이 대기 중입니다.';
    }

    async fetchAnySnapshotForDate(dateString) {
        const config = this.getSupabaseConfig();
        if (!config) {
            throw new Error('supabase-config.js에 프로젝트 URL과 publishable key를 설정해야 합니다.');
        }
        const params = new URLSearchParams({
            select: 'id',
            selected_date: `eq.${dateString}`,
            limit: '1'
        });
        const response = await fetch(
            `${config.url}/rest/v1/mlb_game_table_snapshots?${params.toString()}`,
            {
                cache: 'no-store',
                headers: {
                    Accept: 'application/json',
                    apikey: config.publishableKey,
                    Authorization: `Bearer ${config.publishableKey}`
                }
            }
        );
        if (!response.ok) {
            const detail = await response.text();
            throw new Error(`Supabase 조회 실패 (${response.status}): ${detail}`);
        }
        return await response.json();
    }

    async queueDateScrapeIfMissing(dateString, requestSequence) {
        if (!this.isScrapeRequestDateAllowed(dateString)) return;
        try {
            const existing = await this.fetchAnySnapshotForDate(dateString);
            if (requestSequence !== this.gamesLoadSequence) return;
            if (Array.isArray(existing) && existing.length > 0) {
                this.setDataStatus('저장된 수집 결과가 있습니다. 경기를 선택해 확인해 주세요.');
                return;
            }

            const request = await this.requestScrapeForDate(dateString);
            if (requestSequence !== this.gamesLoadSequence) return;
            this.setDataStatus(this.describeScrapeRequest(request));
        } catch (error) {
            if (requestSequence !== this.gamesLoadSequence) return;
            console.error(error);
            this.setDataStatus(error.message || '자동 수집 요청을 등록하지 못했습니다.', true);
        }
    }

    scheduleSnapshotPoll(game, pollAttempt) {
        if (this.snapshotPollTimer) clearTimeout(this.snapshotPollTimer);
        if (pollAttempt >= 180) {
            this.setDataStatus(
                '수집 요청은 등록됐지만 아직 완료되지 않았습니다. 잠시 후 다시 선택해 주세요.'
            );
            return;
        }

        const expectedGamePk = String(game.gamePk);
        this.snapshotPollTimer = setTimeout(() => {
            const selected = this.currentGames[this.selectedGame];
            if (!selected || String(selected.gamePk) !== expectedGamePk) return;
            void this.loadGameSnapshot(game, {
                requestIfMissing: false,
                pollAttempt: pollAttempt + 1
            });
        }, 30000);
    }

    async fetchGameTableSnapshots(gamePk) {
        const config = this.getSupabaseConfig();
        if (!config) {
            throw new Error('supabase-config.js에 프로젝트 URL과 publishable key를 설정해야 합니다.');
        }

        const params = new URLSearchParams({
            select: 'table_key,table_order,payload,collected_at',
            game_pk: `eq.${gamePk}`,
            status: 'eq.complete',
            order: 'table_order.asc'
        });
        const response = await fetch(
            `${config.url}/rest/v1/mlb_game_table_snapshots?${params.toString()}`,
            {
                cache: 'no-store',
                headers: {
                    Accept: 'application/json',
                    apikey: config.publishableKey,
                    Authorization: `Bearer ${config.publishableKey}`
                }
            }
        );
        if (!response.ok) {
            const detail = await response.text();
            throw new Error(`Supabase 조회 실패 (${response.status}): ${detail}`);
        }
        return await response.json();
    }

    renderStarterSnapshot(tableId, results) {
        const rows = (Array.isArray(results) ? results : []).map(result => {
            const stats = result && result.stats ? result.stats : {};
            return [
                result && result.team,
                result && result.pitcher,
                stats.G,
                stats.IP,
                stats.ERA,
                stats['BB/9'],
                stats.AVG,
                stats.OBP,
                stats.SLG,
                stats.OPS,
                stats.RISP
            ].map(value => value ?? '');
        });
        this.updateTableData(tableId, rows);
    }

    renderUnavailableSnapshot(results) {
        const table = document.getElementById(MLB_TABLE_IDS.unplayablePitchers);
        const tbody = table ? table.querySelector('tbody') : null;
        if (!tbody) return;

        const pitchers = (Array.isArray(results) ? results : []).flatMap(result =>
            result && Array.isArray(result.pitchers) ? result.pitchers : []
        );
        tbody.innerHTML = '';
        pitchers.forEach(pitcher => {
            const row = document.createElement('tr');
            const stats = pitcher && pitcher.stats ? pitcher.stats : {};
            [pitcher.team, pitcher.pitcher, stats.IP].forEach((value, index) => {
                const cell = document.createElement('td');
                if (index === 0) cell.className = 'team-cell';
                if (index === 1) cell.className = 'name-cell';
                cell.textContent = value ?? '';
                row.appendChild(cell);
            });
            tbody.appendChild(row);
        });
        this.mergeTeamCells(tbody);
    }

    renderSnapshotTable(tableKey, payload) {
        const results = payload && Array.isArray(payload.results) ? payload.results : [];
        switch (tableKey) {
            case MLB_TABLE_IDS.starterH2H:
            case MLB_TABLE_IDS.starterRecent:
                this.renderStarterSnapshot(tableKey, results);
                break;
            case MLB_TABLE_IDS.highLevH2H:
            case MLB_TABLE_IDS.highLevRecent:
            case MLB_TABLE_IDS.midLevH2H:
            case MLB_TABLE_IDS.midLevRecent:
            case MLB_TABLE_IDS.lowLevH2H:
            case MLB_TABLE_IDS.lowLevRecent:
                this.renderCollectedLeveragePitchers(tableKey, results);
                break;
            case MLB_TABLE_IDS.unplayablePitchers:
                this.renderUnavailableSnapshot(results);
                break;
            case MLB_TABLE_IDS.hittingRecent:
                this.renderCollectedBattingRecent(results);
                break;
            default:
                console.warn(`알 수 없는 Supabase 테이블 키: ${tableKey}`);
        }
    }

    async loadGameSnapshot(
        game,
        { requestIfMissing = true, pollAttempt = 0 } = {}
    ) {
        if (!game || !game.gamePk) {
            this.setDataStatus('경기 식별자가 없어 저장된 통계를 조회할 수 없습니다.', true);
            return;
        }

        const loadSequence = ++this.snapshotLoadSequence;
        this.setDataStatus('Supabase에서 저장된 통계를 불러오는 중입니다...');
        try {
            const snapshots = await this.fetchGameTableSnapshots(game.gamePk);
            if (loadSequence !== this.snapshotLoadSequence) return;

            const byTable = new Map(
                (Array.isArray(snapshots) ? snapshots : []).map(item => [item.table_key, item])
            );
            let completedCount = 0;
            MLB_SNAPSHOT_TABLE_ORDER.forEach(tableKey => {
                const snapshot = byTable.get(tableKey);
                if (!snapshot) return;
                this.renderSnapshotTable(tableKey, snapshot.payload);
                completedCount += 1;
            });

            if (completedCount === MLB_SNAPSHOT_TABLE_ORDER.length) {
                if (this.snapshotPollTimer) {
                    clearTimeout(this.snapshotPollTimer);
                    this.snapshotPollTimer = null;
                }
                const latest = snapshots
                    .map(item => item.collected_at)
                    .filter(Boolean)
                    .sort()
                    .at(-1);
                const collectedText = latest
                    ? new Date(latest).toLocaleString('ko-KR')
                    : '시간 정보 없음';
                this.setDataStatus(`10개 표 로드 완료 · 수집 시각 ${collectedText}`);
                setTimeout(() => {
                    this.initComparisonChart();
                    this.initBattingComparisonChart();
                }, 100);
            } else if (completedCount > 0) {
                this.setDataStatus(
                    `순차 수집 진행 중입니다 (${completedCount}/${MLB_SNAPSHOT_TABLE_ORDER.length}개 표 완료).`
                );
                if (pollAttempt > 0) this.scheduleSnapshotPoll(game, pollAttempt);
            } else {
                const selectedDate = game.date || this.formatDateForAPI(this.currentDate);
                if (requestIfMissing && this.isScrapeRequestDateAllowed(selectedDate)) {
                    const request = await this.requestScrapeForDate(selectedDate);
                    const queueStatus = this.describeScrapeRequest(request);
                    this.setDataStatus(
                        `${queueStatus} GitHub Actions 상태를 자동으로 확인합니다.`
                    );
                    if (!request || ['pending', 'running'].includes(request.status)) {
                        this.scheduleSnapshotPoll(game, 0);
                    }
                } else if (!requestIfMissing && pollAttempt > 0) {
                    this.setDataStatus(
                        `GitHub Actions 수집을 기다리는 중입니다 (${pollAttempt}/180).`
                    );
                    this.scheduleSnapshotPoll(game, pollAttempt);
                } else {
                    this.setDataStatus('이 경기의 수집 결과가 아직 없습니다.');
                }
            }
        } catch (error) {
            if (loadSequence !== this.snapshotLoadSequence) return;
            console.error(error);
            this.setDataStatus(error.message || '저장된 통계를 불러오지 못했습니다.', true);
        }
    }

    // 기존 호출 경로도 브라우저 스크래핑 대신 저장된 Supabase 스냅샷을 읽는다.
    async runScraperAndLoadData() {
        const selectedGame = this.currentGames[this.selectedGame];
        await this.loadGameSnapshot(selectedGame);
    }

    // JSON 파일에서 투수 통계를 찾아서 테이블에 업데이트
    async loadPitcherStatsFromJSON(jsonData, pitcherName, rowIndex, teamCode) {
        const startingPitcherTable = document.getElementById(MLB_TABLE_IDS.starterH2H);
        if (!startingPitcherTable) {
            return;
        }

        const tbody = startingPitcherTable.querySelector('tbody');
        if (!tbody) {
            return;
        }

        // 행 가져오기 (rowIndex는 0-based)
        const row = tbody.querySelector(`tr:nth-child(${rowIndex + 1})`);
        if (!row) {
            return;
        }
        
        // 테이블에서 투수명 가져오기 (td[2]는 인덱스 1)
        const tablePitcherName = row.cells[1] ? row.cells[1].textContent.trim() : '';
        
        // JSON 데이터에서 Name이 일치하고 팀명도 일치하는 항목 찾기
        const pitcherData = jsonData.find(item => {
            const jsonName = item.Name ? item.Name.trim() : '';
            const nameMatch = jsonName === pitcherName || jsonName === tablePitcherName;
            
            // 팀명도 비교 (약칭 변환 적용)
            let teamMatch = true;
            if (teamCode && item.Tm) {
                teamMatch = this.compareTeamAbbreviations(teamCode, item.Tm);
            }
            
            return nameMatch && teamMatch;
        });
        
        if (pitcherData) {
            console.log(`Stats found for ${pitcherName}:`, pitcherData);
            
            // G, ERA, AVG, OBP, SLG 값 가져오기
            const G = pitcherData.G || '';
            const ERA = pitcherData.ERA || '';
            
            // AVG, OBP, SLG를 소수 셋째자리까지 포맷팅
            let AVG = '';
            if (pitcherData.AVG) {
                const avgValue = parseFloat(pitcherData.AVG);
                if (!isNaN(avgValue)) {
                    AVG = avgValue.toFixed(3);
                } else {
                    AVG = pitcherData.AVG;
                }
            }
            
            let OBP = '';
            if (pitcherData.OBP) {
                const obpValue = parseFloat(pitcherData.OBP);
                if (!isNaN(obpValue)) {
                    OBP = obpValue.toFixed(3);
                } else {
                    OBP = pitcherData.OBP;
                }
            }
            
            let SLG = '';
            if (pitcherData.SLG) {
                const slgValue = parseFloat(pitcherData.SLG);
                if (!isNaN(slgValue)) {
                    SLG = slgValue.toFixed(3);
                } else {
                    SLG = pitcherData.SLG;
                }
            }
            
            // OPS 계산 (OBP + SLG)
            let OPS = '';
            if (OBP && SLG) {
                const obpValue = parseFloat(OBP);
                const slgValue = parseFloat(SLG);
                if (!isNaN(obpValue) && !isNaN(slgValue)) {
                    OPS = (obpValue + slgValue).toFixed(3);
                }
            }
            
            // 테이블에 값 입력
            // 인덱스: G(2), ERA(4), AVG(6), OBP(7), SLG(8), OPS(9)
            if (row.cells.length > 2) {
                row.cells[2].textContent = G; // G (인덱스 2)
            }
            if (row.cells.length > 4) {
                row.cells[4].textContent = ERA; // ERA (인덱스 4)
            }
            if (row.cells.length > 6) {
                row.cells[6].textContent = AVG; // AVG (인덱스 6)
            }
            if (row.cells.length > 7) {
                row.cells[7].textContent = OBP; // OBP (인덱스 7)
            }
            if (row.cells.length > 8) {
                row.cells[8].textContent = SLG; // SLG (인덱스 8)
            }
            if (row.cells.length > 9) {
                row.cells[9].textContent = OPS; // OPS (인덱스 9)
            }
            
            console.log(`Successfully updated stats for ${pitcherName}`);
        } else {
            console.warn(`Stats not found for ${pitcherName} in JSON data`);
        }
    }
    
    // statgroup=2 JSON 파일에서 IP와 BB/9를 찾아서 테이블에 업데이트
    async loadPitcherStatsFromJSON2(jsonData2, pitcherName, rowIndex, teamCode) {
        const startingPitcherTable = document.getElementById(MLB_TABLE_IDS.starterH2H);
        if (!startingPitcherTable) {
            return;
        }

        const tbody = startingPitcherTable.querySelector('tbody');
        if (!tbody) {
            return;
        }

        // 행 가져오기 (rowIndex는 0-based)
        const row = tbody.querySelector(`tr:nth-child(${rowIndex + 1})`);
        if (!row) {
            return;
        }
        
        // 테이블에서 투수명 가져오기 (td[2]는 인덱스 1)
        const tablePitcherName = row.cells[1] ? row.cells[1].textContent.trim() : '';
        
        // JSON 데이터에서 Name이 일치하고 팀명도 일치하는 항목 찾기
        const pitcherData = jsonData2.find(item => {
            const jsonName = item.Name ? item.Name.trim() : '';
            const nameMatch = jsonName === pitcherName || jsonName === tablePitcherName;
            
            // 팀명도 비교 (약칭 변환 적용)
            let teamMatch = true;
            if (teamCode && item.Tm) {
                teamMatch = this.compareTeamAbbreviations(teamCode, item.Tm);
            }
            
            return nameMatch && teamMatch;
        });
        
        if (pitcherData) {
            console.log(`Stats2 found for ${pitcherName}:`, pitcherData);
            
            // IP와 BB/9 값 가져오기
            const IP = pitcherData.IP || '';
            const BB9 = pitcherData['BB/9'] || '';
            
            // 테이블에 값 입력
            // IP는 td[4] = 인덱스 3, BB/9는 td[6] = 인덱스 5
            if (row.cells.length > 3) {
                row.cells[3].textContent = IP; // IP (인덱스 3)
            }
            if (row.cells.length > 5) {
                row.cells[5].textContent = BB9; // BB/9 (인덱스 5)
            }
            
            console.log(`Successfully updated IP and BB/9 for ${pitcherName}`);
        } else {
            console.warn(`Stats2 not found for ${pitcherName} in JSON data`);
        }
    }
    
    // splitArr=42,59 JSON 파일에서 AVG를 찾아서 테이블에 업데이트 (RISP 열에 표시)
    async loadPitcherStatsFromJSON3(jsonData3, pitcherName, rowIndex, teamCode) {
        const startingPitcherTable = document.getElementById(MLB_TABLE_IDS.starterH2H);
        if (!startingPitcherTable) {
            return;
        }

        const tbody = startingPitcherTable.querySelector('tbody');
        if (!tbody) {
            return;
        }

        // 행 가져오기 (rowIndex는 0-based)
        const row = tbody.querySelector(`tr:nth-child(${rowIndex + 1})`);
        if (!row) {
            return;
        }
        
        // 테이블에서 투수명 가져오기 (td[2]는 인덱스 1)
        const tablePitcherName = row.cells[1] ? row.cells[1].textContent.trim() : '';
        
        // JSON 데이터에서 Name이 일치하고 팀명도 일치하는 항목 찾기
        const pitcherData = jsonData3.find(item => {
            const jsonName = item.Name ? item.Name.trim() : '';
            const nameMatch = jsonName === pitcherName || jsonName === tablePitcherName;
            
            // 팀명도 비교 (약칭 변환 적용)
            let teamMatch = true;
            if (teamCode && item.Tm) {
                teamMatch = this.compareTeamAbbreviations(teamCode, item.Tm);
            }
            
            return nameMatch && teamMatch;
        });
        
        if (pitcherData) {
            console.log(`Stats3 found for ${pitcherName}:`, pitcherData);
            
            // AVG 값 가져오기 및 포맷팅
            let AVG = '';
            if (pitcherData.AVG) {
                const avgValue = parseFloat(pitcherData.AVG);
                if (!isNaN(avgValue)) {
                    AVG = avgValue.toFixed(3);
                } else {
                    AVG = pitcherData.AVG;
                }
            }
            
            // 테이블에 값 입력
            // RISP는 td[11] = 인덱스 10
            if (row.cells.length > 10) {
                row.cells[10].textContent = AVG; // RISP (인덱스 10)
            }
            
            console.log(`Successfully updated AVG (RISP) for ${pitcherName}`);
        } else {
            console.warn(`Stats3 not found for ${pitcherName} in JSON data`);
        }
    }
    
    // 새 Python 수집 결과({ pitchers: [...] })를 Leverage 표에 선수별 행으로 표시
    renderCollectedLeveragePitchers(tableId, collectedResults) {
        const table = document.getElementById(tableId);
        const tbody = table ? table.querySelector('tbody') : null;
        if (!tbody) {
            return 0;
        }

        const results = Array.isArray(collectedResults)
            ? collectedResults
            : [collectedResults];
        const pitchers = results.flatMap(result =>
            result && Array.isArray(result.pitchers) ? result.pitchers : []
        );

        // 표 전체를 한 번만 비운 뒤, 투수 한 명마다 새 행을 아래에 추가한다.
        tbody.innerHTML = '';
        pitchers.forEach(pitcherData => {
            const stats = pitcherData && pitcherData.stats ? pitcherData.stats : {};
            const rowValues = [
                pitcherData && pitcherData.team,
                pitcherData && pitcherData.pitcher,
                stats.G,
                stats.IP,
                stats.ERA,
                stats['BB/9'],
                stats.AVG,
                stats.OBP,
                stats.SLG,
                stats.OPS,
                stats.RISP
            ];
            const row = document.createElement('tr');

            rowValues.forEach((value, columnIndex) => {
                const cell = document.createElement('td');
                if (columnIndex === 0) cell.className = 'team-cell';
                if (columnIndex === 1) cell.className = 'name-cell';
                cell.textContent = value ?? '';
                row.appendChild(cell);
            });

            tbody.appendChild(row);
        });

        // 선수별 행은 유지하고, 연속된 같은 팀의 Team 셀만 묶는다.
        this.mergeTeamCells(tbody);
        return pitchers.length;
    }

    getCollectedLeverageResults(value) {
        if (value && !Array.isArray(value) && Array.isArray(value.pitchers)) {
            return [value];
        }
        if (Array.isArray(value)) {
            return value.filter(item => item && Array.isArray(item.pitchers));
        }
        return [];
    }

    // High Leverage 데이터를 테이블에 표시
    async loadHighLeverageStats(jsonData4, jsonData5, jsonData6, awayTeamCode, homeTeamCode) {
        const collectedResults = this.getCollectedLeverageResults(jsonData4);
        if (collectedResults.length > 0) {
            this.renderCollectedLeveragePitchers(
                MLB_TABLE_IDS.highLevH2H,
                collectedResults
            );
            return;
        }

        const highLeverageTable = document.getElementById(MLB_TABLE_IDS.highLevH2H);
        if (!highLeverageTable) {
            return;
        }

        const tbody = highLeverageTable.querySelector('tbody');
        if (!tbody) {
            return;
        }

        // 기존 행 제거
        tbody.innerHTML = '';

        // 팀명 약칭 정규화
        const normalizedAwayTeam = this.normalizeTeamAbbreviation(awayTeamCode);
        const normalizedHomeTeam = this.normalizeTeamAbbreviation(homeTeamCode);

        // 각 팀의 투수 데이터 찾기 (statgroup=1)
        const awayTeamPitchers = jsonData4.filter(item => {
            if (!item.Tm) return false;
            const normalizedTm = this.normalizeTeamAbbreviation(item.Tm);
            return this.compareTeamAbbreviations(normalizedAwayTeam, normalizedTm);
        });

        const homeTeamPitchers = jsonData4.filter(item => {
            if (!item.Tm) return false;
            const normalizedTm = this.normalizeTeamAbbreviation(item.Tm);
            return this.compareTeamAbbreviations(normalizedHomeTeam, normalizedTm);
        });

        // 모든 투수 데이터 합치기 (away 팀 먼저, home 팀 나중)
        const allPitchers = [...awayTeamPitchers, ...homeTeamPitchers];

        // 각 투수에 대해 행 생성
        allPitchers.forEach((pitcherData, index) => {
            const row = document.createElement('tr');
            
            // Team (인덱스 0)
            const teamCell = document.createElement('td');
            teamCell.className = 'team-cell';
            const teamCode = index < awayTeamPitchers.length ? awayTeamCode : homeTeamCode;
            teamCell.textContent = teamCode;
            row.appendChild(teamCell);

            // Name (인덱스 1)
            const nameCell = document.createElement('td');
            nameCell.className = 'name-cell';
            const pitcherName = pitcherData.Name || '';
            nameCell.textContent = pitcherName;
            row.appendChild(nameCell);

            // G (인덱스 2)
            const gCell = document.createElement('td');
            gCell.textContent = pitcherData.G || '';
            row.appendChild(gCell);

            // IP (인덱스 3) - jsonData5에서 가져오기
            const ipCell = document.createElement('td');
            let IP = '';
            // jsonData5에서 같은 이름의 투수 찾기
            const pitcherData5 = jsonData5.find(item => {
                const jsonName = item.Name ? item.Name.trim() : '';
                return jsonName === pitcherName.trim();
            });
            if (pitcherData5) {
                IP = pitcherData5.IP || '';
            }
            ipCell.textContent = IP;
            row.appendChild(ipCell);

            // ERA (인덱스 4)
            const eraCell = document.createElement('td');
            eraCell.textContent = pitcherData.ERA || '';
            row.appendChild(eraCell);

            // BB/9 (인덱스 5) - jsonData5에서 가져오기
            const bb9Cell = document.createElement('td');
            let BB9 = '';
            if (pitcherData5) {
                BB9 = pitcherData5['BB/9'] || '';
            }
            bb9Cell.textContent = BB9;
            row.appendChild(bb9Cell);

            // AVG (인덱스 6) - 소수 셋째자리까지 포맷팅
            const avgCell = document.createElement('td');
            let AVG = '';
            if (pitcherData.AVG) {
                const avgValue = parseFloat(pitcherData.AVG);
                if (!isNaN(avgValue)) {
                    AVG = avgValue.toFixed(3);
                } else {
                    AVG = pitcherData.AVG;
                }
            }
            avgCell.textContent = AVG;
            row.appendChild(avgCell);

            // OBP (인덱스 7) - 소수 셋째자리까지 포맷팅
            const obpCell = document.createElement('td');
            let OBP = '';
            if (pitcherData.OBP) {
                const obpValue = parseFloat(pitcherData.OBP);
                if (!isNaN(obpValue)) {
                    OBP = obpValue.toFixed(3);
                } else {
                    OBP = pitcherData.OBP;
                }
            }
            obpCell.textContent = OBP;
            row.appendChild(obpCell);

            // SLG (인덱스 8) - 소수 셋째자리까지 포맷팅
            const slgCell = document.createElement('td');
            let SLG = '';
            if (pitcherData.SLG) {
                const slgValue = parseFloat(pitcherData.SLG);
                if (!isNaN(slgValue)) {
                    SLG = slgValue.toFixed(3);
                } else {
                    SLG = pitcherData.SLG;
                }
            }
            slgCell.textContent = SLG;
            row.appendChild(slgCell);

            // OPS (인덱스 9) - 계산 및 포맷팅
            const opsCell = document.createElement('td');
            let OPS = '';
            if (OBP && SLG) {
                const obpValue = parseFloat(OBP);
                const slgValue = parseFloat(SLG);
                if (!isNaN(obpValue) && !isNaN(slgValue)) {
                    OPS = (obpValue + slgValue).toFixed(3);
                }
            }
            opsCell.textContent = OPS;
            row.appendChild(opsCell);

            // RISP (인덱스 10) - jsonData6에서 AVG 값 가져오기
            const rispCell = document.createElement('td');
            let RISP_AVG = '';
            // jsonData6에서 같은 이름의 투수 찾기
            const pitcherData6 = jsonData6.find(item => {
                const jsonName = item.Name ? item.Name.trim() : '';
                return jsonName === pitcherName.trim();
            });
            if (pitcherData6 && pitcherData6.AVG) {
                const avgValue = parseFloat(pitcherData6.AVG);
                if (!isNaN(avgValue)) {
                    RISP_AVG = avgValue.toFixed(3);
                } else {
                    RISP_AVG = pitcherData6.AVG;
                }
            }
            rispCell.textContent = RISP_AVG;
            row.appendChild(rispCell);

            tbody.appendChild(row);
        });

        // 같은 팀명 병합
        this.mergeTeamCells(tbody);

        console.log(`High Leverage stats loaded: ${allPitchers.length} pitchers`);
    }
    
    // Medium Leverage 데이터를 테이블에 표시
    async loadMediumLeverageStats(jsonData7, jsonData8, jsonData9, awayTeamCode, homeTeamCode) {
        const collectedResults = this.getCollectedLeverageResults(jsonData7);
        if (collectedResults.length > 0) {
            this.renderCollectedLeveragePitchers(
                MLB_TABLE_IDS.midLevH2H,
                collectedResults
            );
            return;
        }

        const mediumLeverageTable = document.getElementById(MLB_TABLE_IDS.midLevH2H);
        if (!mediumLeverageTable) {
            return;
        }

        const tbody = mediumLeverageTable.querySelector('tbody');
        if (!tbody) {
            return;
        }

        // 기존 행 제거
        tbody.innerHTML = '';

        // 팀명 약칭 정규화
        const normalizedAwayTeam = this.normalizeTeamAbbreviation(awayTeamCode);
        const normalizedHomeTeam = this.normalizeTeamAbbreviation(homeTeamCode);

        // 각 팀의 투수 데이터 찾기 (statgroup=1)
        const awayTeamPitchers = jsonData7.filter(item => {
            if (!item.Tm) return false;
            const normalizedTm = this.normalizeTeamAbbreviation(item.Tm);
            return this.compareTeamAbbreviations(normalizedAwayTeam, normalizedTm);
        });

        const homeTeamPitchers = jsonData7.filter(item => {
            if (!item.Tm) return false;
            const normalizedTm = this.normalizeTeamAbbreviation(item.Tm);
            return this.compareTeamAbbreviations(normalizedHomeTeam, normalizedTm);
        });

        // 모든 투수 데이터 합치기 (away 팀 먼저, home 팀 나중)
        const allPitchers = [...awayTeamPitchers, ...homeTeamPitchers];

        // 각 투수에 대해 행 생성
        allPitchers.forEach((pitcherData, index) => {
            const row = document.createElement('tr');
            
            // Team (인덱스 0)
            const teamCell = document.createElement('td');
            teamCell.className = 'team-cell';
            const teamCode = index < awayTeamPitchers.length ? awayTeamCode : homeTeamCode;
            teamCell.textContent = teamCode;
            row.appendChild(teamCell);

            // Name (인덱스 1)
            const nameCell = document.createElement('td');
            nameCell.className = 'name-cell';
            const pitcherName = pitcherData.Name || '';
            nameCell.textContent = pitcherName;
            row.appendChild(nameCell);

            // G (인덱스 2)
            const gCell = document.createElement('td');
            gCell.textContent = pitcherData.G || '';
            row.appendChild(gCell);

            // IP (인덱스 3) - jsonData8에서 가져오기
            const ipCell = document.createElement('td');
            let IP = '';
            // jsonData8에서 같은 이름의 투수 찾기
            const pitcherData8 = jsonData8.find(item => {
                const jsonName = item.Name ? item.Name.trim() : '';
                return jsonName === pitcherName.trim();
            });
            if (pitcherData8) {
                IP = pitcherData8.IP || '';
            }
            ipCell.textContent = IP;
            row.appendChild(ipCell);

            // ERA (인덱스 4)
            const eraCell = document.createElement('td');
            eraCell.textContent = pitcherData.ERA || '';
            row.appendChild(eraCell);

            // BB/9 (인덱스 5) - jsonData8에서 가져오기
            const bb9Cell = document.createElement('td');
            let BB9 = '';
            if (pitcherData8) {
                BB9 = pitcherData8['BB/9'] || '';
            }
            bb9Cell.textContent = BB9;
            row.appendChild(bb9Cell);

            // AVG (인덱스 6) - 소수 셋째자리까지 포맷팅
            const avgCell = document.createElement('td');
            let AVG = '';
            if (pitcherData.AVG) {
                const avgValue = parseFloat(pitcherData.AVG);
                if (!isNaN(avgValue)) {
                    AVG = avgValue.toFixed(3);
                } else {
                    AVG = pitcherData.AVG;
                }
            }
            avgCell.textContent = AVG;
            row.appendChild(avgCell);

            // OBP (인덱스 7) - 소수 셋째자리까지 포맷팅
            const obpCell = document.createElement('td');
            let OBP = '';
            if (pitcherData.OBP) {
                const obpValue = parseFloat(pitcherData.OBP);
                if (!isNaN(obpValue)) {
                    OBP = obpValue.toFixed(3);
                } else {
                    OBP = pitcherData.OBP;
                }
            }
            obpCell.textContent = OBP;
            row.appendChild(obpCell);

            // SLG (인덱스 8) - 소수 셋째자리까지 포맷팅
            const slgCell = document.createElement('td');
            let SLG = '';
            if (pitcherData.SLG) {
                const slgValue = parseFloat(pitcherData.SLG);
                if (!isNaN(slgValue)) {
                    SLG = slgValue.toFixed(3);
                } else {
                    SLG = pitcherData.SLG;
                }
            }
            slgCell.textContent = SLG;
            row.appendChild(slgCell);

            // OPS (인덱스 9) - 계산 및 포맷팅
            const opsCell = document.createElement('td');
            let OPS = '';
            if (OBP && SLG) {
                const obpValue = parseFloat(OBP);
                const slgValue = parseFloat(SLG);
                if (!isNaN(obpValue) && !isNaN(slgValue)) {
                    OPS = (obpValue + slgValue).toFixed(3);
                }
            }
            opsCell.textContent = OPS;
            row.appendChild(opsCell);

            // RISP (인덱스 10) - jsonData9에서 AVG 값 가져오기
            const rispCell = document.createElement('td');
            let RISP_AVG = '';
            // jsonData9에서 같은 이름의 투수 찾기
            const pitcherData9 = jsonData9.find(item => {
                const jsonName = item.Name ? item.Name.trim() : '';
                return jsonName === pitcherName.trim();
            });
            if (pitcherData9 && pitcherData9.AVG) {
                const avgValue = parseFloat(pitcherData9.AVG);
                if (!isNaN(avgValue)) {
                    RISP_AVG = avgValue.toFixed(3);
                } else {
                    RISP_AVG = pitcherData9.AVG;
                }
            }
            rispCell.textContent = RISP_AVG;
            row.appendChild(rispCell);

            tbody.appendChild(row);
        });

        // 같은 팀명 병합
        this.mergeTeamCells(tbody);

        console.log(`Medium Leverage stats loaded: ${allPitchers.length} pitchers`);
    }
    
    // Low Leverage 데이터를 테이블에 표시
    async loadLowLeverageStats(jsonData10, jsonData11, jsonData12, awayTeamCode, homeTeamCode) {
        const collectedResults = this.getCollectedLeverageResults(jsonData10);
        if (collectedResults.length > 0) {
            this.renderCollectedLeveragePitchers(
                MLB_TABLE_IDS.lowLevH2H,
                collectedResults
            );
            return;
        }

        const lowLeverageTable = document.getElementById(MLB_TABLE_IDS.lowLevH2H);
        if (!lowLeverageTable) {
            return;
        }

        const tbody = lowLeverageTable.querySelector('tbody');
        if (!tbody) {
            return;
        }

        // 기존 행 제거
        tbody.innerHTML = '';

        // 팀명 약칭 정규화
        const normalizedAwayTeam = this.normalizeTeamAbbreviation(awayTeamCode);
        const normalizedHomeTeam = this.normalizeTeamAbbreviation(homeTeamCode);

        // 각 팀의 투수 데이터 찾기 (statgroup=1)
        const awayTeamPitchers = jsonData10.filter(item => {
            if (!item.Tm) return false;
            const normalizedTm = this.normalizeTeamAbbreviation(item.Tm);
            return this.compareTeamAbbreviations(normalizedAwayTeam, normalizedTm);
        });

        const homeTeamPitchers = jsonData10.filter(item => {
            if (!item.Tm) return false;
            const normalizedTm = this.normalizeTeamAbbreviation(item.Tm);
            return this.compareTeamAbbreviations(normalizedHomeTeam, normalizedTm);
        });

        // 모든 투수 데이터 합치기 (away 팀 먼저, home 팀 나중)
        const allPitchers = [...awayTeamPitchers, ...homeTeamPitchers];

        // 각 투수에 대해 행 생성
        allPitchers.forEach((pitcherData, index) => {
            const row = document.createElement('tr');
            
            // Team (인덱스 0)
            const teamCell = document.createElement('td');
            teamCell.className = 'team-cell';
            const teamCode = index < awayTeamPitchers.length ? awayTeamCode : homeTeamCode;
            teamCell.textContent = teamCode;
            row.appendChild(teamCell);

            // Name (인덱스 1)
            const nameCell = document.createElement('td');
            nameCell.className = 'name-cell';
            const pitcherName = pitcherData.Name || '';
            nameCell.textContent = pitcherName;
            row.appendChild(nameCell);

            // G (인덱스 2)
            const gCell = document.createElement('td');
            gCell.textContent = pitcherData.G || '';
            row.appendChild(gCell);

            // IP (인덱스 3) - jsonData11에서 가져오기
            const ipCell = document.createElement('td');
            let IP = '';
            // jsonData11에서 같은 이름의 투수 찾기
            const pitcherData11 = jsonData11.find(item => {
                const jsonName = item.Name ? item.Name.trim() : '';
                return jsonName === pitcherName.trim();
            });
            if (pitcherData11) {
                IP = pitcherData11.IP || '';
            }
            ipCell.textContent = IP;
            row.appendChild(ipCell);

            // ERA (인덱스 4)
            const eraCell = document.createElement('td');
            eraCell.textContent = pitcherData.ERA || '';
            row.appendChild(eraCell);

            // BB/9 (인덱스 5) - jsonData11에서 가져오기
            const bb9Cell = document.createElement('td');
            let BB9 = '';
            if (pitcherData11) {
                BB9 = pitcherData11['BB/9'] || '';
            }
            bb9Cell.textContent = BB9;
            row.appendChild(bb9Cell);

            // AVG (인덱스 6) - 소수 셋째자리까지 포맷팅
            const avgCell = document.createElement('td');
            let AVG = '';
            if (pitcherData.AVG) {
                const avgValue = parseFloat(pitcherData.AVG);
                if (!isNaN(avgValue)) {
                    AVG = avgValue.toFixed(3);
                } else {
                    AVG = pitcherData.AVG;
                }
            }
            avgCell.textContent = AVG;
            row.appendChild(avgCell);

            // OBP (인덱스 7) - 소수 셋째자리까지 포맷팅
            const obpCell = document.createElement('td');
            let OBP = '';
            if (pitcherData.OBP) {
                const obpValue = parseFloat(pitcherData.OBP);
                if (!isNaN(obpValue)) {
                    OBP = obpValue.toFixed(3);
                } else {
                    OBP = pitcherData.OBP;
                }
            }
            obpCell.textContent = OBP;
            row.appendChild(obpCell);

            // SLG (인덱스 8) - 소수 셋째자리까지 포맷팅
            const slgCell = document.createElement('td');
            let SLG = '';
            if (pitcherData.SLG) {
                const slgValue = parseFloat(pitcherData.SLG);
                if (!isNaN(slgValue)) {
                    SLG = slgValue.toFixed(3);
                } else {
                    SLG = pitcherData.SLG;
                }
            }
            slgCell.textContent = SLG;
            row.appendChild(slgCell);

            // OPS (인덱스 9) - 계산 및 포맷팅
            const opsCell = document.createElement('td');
            let OPS = '';
            if (OBP && SLG) {
                const obpValue = parseFloat(OBP);
                const slgValue = parseFloat(SLG);
                if (!isNaN(obpValue) && !isNaN(slgValue)) {
                    OPS = (obpValue + slgValue).toFixed(3);
                }
            }
            opsCell.textContent = OPS;
            row.appendChild(opsCell);

            // RISP (인덱스 10) - jsonData12에서 AVG 값 가져오기
            const rispCell = document.createElement('td');
            let RISP_AVG = '';
            // jsonData12에서 같은 이름의 투수 찾기
            const pitcherData12 = jsonData12.find(item => {
                const jsonName = item.Name ? item.Name.trim() : '';
                return jsonName === pitcherName.trim();
            });
            if (pitcherData12 && pitcherData12.AVG) {
                const avgValue = parseFloat(pitcherData12.AVG);
                if (!isNaN(avgValue)) {
                    RISP_AVG = avgValue.toFixed(3);
                } else {
                    RISP_AVG = pitcherData12.AVG;
                }
            }
            rispCell.textContent = RISP_AVG;
            row.appendChild(rispCell);

            tbody.appendChild(row);
        });

        // 같은 팀명 병합
        this.mergeTeamCells(tbody);

        console.log(`Low Leverage stats loaded: ${allPitchers.length} pitchers`);
    }
    
    // 출전 불가 투수 (3연투) 데이터를 테이블에 표시
    async loadUnavailablePitchers(jsonData13, awayTeamCode, homeTeamCode) {
        const unavailablePitcherTable = document.getElementById(MLB_TABLE_IDS.unplayablePitchers);
        if (!unavailablePitcherTable) {
            return;
        }

        const tbody = unavailablePitcherTable.querySelector('tbody');
        if (!tbody) {
            return;
        }

        // 기존 행 제거
        tbody.innerHTML = '';

        // 팀명 약칭 정규화
        const normalizedAwayTeam = this.normalizeTeamAbbreviation(awayTeamCode);
        const normalizedHomeTeam = this.normalizeTeamAbbreviation(homeTeamCode);

        // 각 팀의 투수 데이터 찾기 (jsonData13에서 직접 필터링)
        const awayTeamPitchers = jsonData13.filter(item => {
            if (!item.Tm) return false;
            const normalizedTm = this.normalizeTeamAbbreviation(item.Tm);
            return this.compareTeamAbbreviations(normalizedAwayTeam, normalizedTm);
        });

        const homeTeamPitchers = jsonData13.filter(item => {
            if (!item.Tm) return false;
            const normalizedTm = this.normalizeTeamAbbreviation(item.Tm);
            return this.compareTeamAbbreviations(normalizedHomeTeam, normalizedTm);
        });

        // 모든 투수 데이터 합치기 (away 팀 먼저, home 팀 나중)
        const allPitchers = [...awayTeamPitchers, ...homeTeamPitchers];

        // 각 투수에 대해 행 생성
        allPitchers.forEach((pitcherData, index) => {
            const row = document.createElement('tr');
            
            // Team (인덱스 0)
            const teamCell = document.createElement('td');
            teamCell.className = 'team-cell';
            const teamCode = index < awayTeamPitchers.length ? awayTeamCode : homeTeamCode;
            teamCell.textContent = teamCode;
            row.appendChild(teamCell);

            // Name (인덱스 1)
            const nameCell = document.createElement('td');
            nameCell.className = 'name-cell';
            const pitcherName = pitcherData.Name || '';
            nameCell.textContent = pitcherName;
            row.appendChild(nameCell);

            // IP (인덱스 2) - jsonData13에서 직접 가져오기
            const ipCell = document.createElement('td');
            const IP = pitcherData.IP || '';
            ipCell.textContent = IP;
            row.appendChild(ipCell);

            tbody.appendChild(row);
        });

        // 같은 팀명 병합
        this.mergeTeamCells(tbody);

        console.log(`Unavailable pitchers (3연투) loaded: ${allPitchers.length} pitchers`);
    }
    
    // 같은 팀명을 가진 연속된 행들을 병합하는 함수
    mergeTeamCells(tbody) {
        const rows = Array.from(tbody.querySelectorAll('tr'));
        if (rows.length === 0) return;

        let currentTeam = null;
        let startRow = null;
        let count = 0;

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const teamCell = row.querySelector('td.team-cell');
            if (!teamCell) continue;

            const teamText = teamCell.textContent.trim();

            if (teamText === currentTeam) {
                // 같은 팀이면 카운트 증가
                count++;
            } else {
                // 다른 팀이면 이전 팀 병합 처리
                if (count > 1 && startRow) {
                    const startTeamCell = startRow.querySelector('td.team-cell');
                    startTeamCell.setAttribute('rowspan', count);
                }
                // 새 팀 시작
                currentTeam = teamText;
                startRow = row;
                count = 1;
            }
        }

        // 마지막 팀 병합 처리
        if (count > 1 && startRow) {
            const startTeamCell = startRow.querySelector('td.team-cell');
            startTeamCell.setAttribute('rowspan', count);
        }

        // 병합된 셀 제거
        currentTeam = null;
        startRow = null;
        count = 0;

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const teamCell = row.querySelector('td.team-cell');
            if (!teamCell) continue;

            const teamText = teamCell.textContent.trim();

            if (teamText === currentTeam) {
                // 같은 팀이면 이 셀 제거 (첫 번째 행 제외)
                if (count > 0) {
                    teamCell.remove();
                }
                count++;
            } else {
                // 새 팀 시작
                currentTeam = teamText;
                count = 1;
            }
        }
    }
    
    // 날짜를 API 형식 (YYYY-MM-DD)으로 변환
    formatDateForAPI(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    
    // 게임 관련 함수들
    initializeGameSelection() {
        // 게임 선택 이벤트는 renderGames에서 동적으로 설정됨
        console.log('Game selection initialized');
    }
    
    initializePagination() {
        // DOM이 완전히 로드된 후 실행되도록 setTimeout 사용
        setTimeout(() => {
            const navArrows = document.querySelectorAll('.nav-arrow');
            const paginationDots = document.querySelectorAll('.pagination-dot');
            
            console.log(`Found ${navArrows.length} nav arrows and ${paginationDots.length} pagination dots`);
            
            // 왼쪽 화살표 클릭
            if (navArrows[0]) {
                navArrows[0].addEventListener('click', (e) => {
                    e.preventDefault();
                    console.log('Previous page clicked');
                    this.previousPage();
                });
            }
            
            // 오른쪽 화살표 클릭
            if (navArrows[1]) {
                navArrows[1].addEventListener('click', (e) => {
                    e.preventDefault();
                    console.log('Next page clicked');
                    this.nextPage();
                });
            }
            
            // 페이지네이션 점 클릭
            paginationDots.forEach((dot, index) => {
                dot.addEventListener('click', (e) => {
                    e.preventDefault();
                    console.log(`Page ${index} clicked`);
                    this.goToPage(index);
                });
            });
            
            this.updatePagination();
        }, 100);
    }
    
    previousPage() {
        if (this.currentPage > 0) {
            this.currentPage--;
            this.updateGameDisplay();
            this.updatePagination();
        }
    }
    
    nextPage() {
        const totalPages = Math.ceil(this.totalGames / this.gamesPerPage);
        console.log(`Current page: ${this.currentPage}, Total pages: ${totalPages}`);
        if (this.currentPage < totalPages - 1) {
            this.currentPage++;
            console.log(`Moving to page: ${this.currentPage}`);
            this.updateGameDisplay();
            this.updatePagination();
        } else {
            console.log('Already at last page');
        }
    }
    
    goToPage(pageIndex) {
        const totalPages = Math.ceil(this.totalGames / this.gamesPerPage);
        if (pageIndex >= 0 && pageIndex < totalPages) {
            this.currentPage = pageIndex;
            this.updateGameDisplay();
            this.updatePagination();
        }
    }
    
    updateGameDisplay() {
        const gameBoxes = document.querySelectorAll('.game-box');
        const gamesContainer = document.getElementById('gamesContainer');
        const startIndex = this.currentPage * this.gamesPerPage;
        const endIndex = Math.min(startIndex + this.gamesPerPage, this.totalGames);
        const currentPageGamesCount = endIndex - startIndex;
        
        console.log(`Showing games ${startIndex} to ${endIndex-1}`);
        
        gameBoxes.forEach((box, index) => {
            if (index >= startIndex && index < endIndex) {
                box.style.display = 'flex';
            } else {
                box.style.display = 'none';
            }
        });
        
        // 두 번째, 세 번째 페이지에서 4개 이하의 게임이 있을 때 가운데 정렬
        if ((this.currentPage === 1 || this.currentPage === 2) && currentPageGamesCount <= 4) {
            gamesContainer.classList.add('center-align');
        } else {
            gamesContainer.classList.remove('center-align');
        }
    }
    
    updatePagination() {
        const paginationDots = document.querySelectorAll('.pagination-dot');
        const totalPages = Math.ceil(this.totalGames / this.gamesPerPage);
        
        // 페이지네이션 점 표시/숨김
        paginationDots.forEach((dot, index) => {
            if (index < totalPages) {
                dot.style.display = 'block';
                if (index === this.currentPage) {
                    dot.classList.add('active');
                } else {
                    dot.classList.remove('active');
                }
            } else {
                dot.style.display = 'none';
            }
        });
        
        // 화살표 활성화/비활성화
        const navArrows = document.querySelectorAll('.nav-arrow');
        if (navArrows[0]) { // 왼쪽 화살표
            navArrows[0].style.opacity = this.currentPage > 0 ? '1' : '0.5';
            navArrows[0].style.cursor = this.currentPage > 0 ? 'pointer' : 'not-allowed';
        }
        if (navArrows[1]) { // 오른쪽 화살표
            navArrows[1].style.opacity = this.currentPage < totalPages - 1 ? '1' : '0.5';
            navArrows[1].style.cursor = this.currentPage < totalPages - 1 ? 'pointer' : 'not-allowed';
        }
    }
    
    async loadGamesForCurrentDate({ queueIfMissing = false } = {}) {
        const requestedDate = new Date(this.currentDate);
        const requestSequence = ++this.gamesLoadSequence;
        const dateString = this.formatDateForAPI(requestedDate);
        this.renderGamesMessage(`${dateString} MLB 일정을 불러오는 중입니다...`);

        try {
            const games = await getGamesForDate(requestedDate);
            if (requestSequence !== this.gamesLoadSequence) return;
            this.renderGames(games);
            if (queueIfMissing && games.length > 0) {
                await this.queueDateScrapeIfMissing(dateString, requestSequence);
            }
        } catch (error) {
            if (requestSequence !== this.gamesLoadSequence) return;
            console.error('MLB 일정을 불러오지 못했습니다.', error);
            this.renderGamesMessage('MLB 일정을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.', true);
        }
    }
    
    loadGamesForDate(date) {
        this.currentDate = new Date(date);
        return this.loadGamesForCurrentDate();
    }

    renderGamesMessage(message, isError = false) {
        const gamesContainer = document.getElementById('gamesContainer');
        if (!gamesContainer) return;

        gamesContainer.innerHTML = '';
        const messageDiv = document.createElement('div');
        messageDiv.className = 'games-message';
        if (isError) messageDiv.classList.add('error');
        messageDiv.textContent = message;
        gamesContainer.appendChild(messageDiv);

        this.currentGames = [];
        this.totalGames = 0;
        this.currentPage = 0;
        this.selectedGame = null;
        this.updatePagination();
        this.resetGameDetails();
    }

    resetGameDetails() {
        const awayTeamBox = document.getElementById('awayTeamBox');
        const homeTeamBox = document.getElementById('homeTeamBox');
        if (awayTeamBox) awayTeamBox.textContent = '팀 선택';
        if (homeTeamBox) homeTeamBox.textContent = '팀 선택';

        this.clearAllTables();
        this.updatePitcherInfo('away', '선발투수 선택', []);
        this.updatePitcherInfo('home', '선발투수 선택', []);
    }
    
    renderGames(games) {
        const gamesContainer = document.getElementById('gamesContainer');
        if (!gamesContainer) return;
        
        gamesContainer.innerHTML = '';
        this.currentGames = games;
        
        if (games.length === 0) {
            const noGamesDiv = document.createElement('div');
            noGamesDiv.textContent = '해당 날짜에는 경기가 없습니다';
            noGamesDiv.style.textAlign = 'center';
            noGamesDiv.style.padding = '20px';
            noGamesDiv.style.color = '#666';
            noGamesDiv.style.fontStyle = 'normal';
            noGamesDiv.style.width = '100%';
            noGamesDiv.style.display = 'flex';
            noGamesDiv.style.alignItems = 'center';
            noGamesDiv.style.justifyContent = 'center';
            gamesContainer.appendChild(noGamesDiv);
            this.totalGames = 0; // 경기가 없는 날짜일 때 전체 게임 수를 0으로 설정
            this.updatePagination();
            this.resetGameDetails();
            return;
        }
        
        games.forEach((game, index) => {
            const gameBox = document.createElement('div');
            gameBox.className = 'game-box';
            gameBox.dataset.awayTeam = game.away;
            gameBox.dataset.homeTeam = game.home;
            gameBox.dataset.gamePk = game.gamePk || '';
            gameBox.title = `${game.awayName} vs ${game.homeName}\n출처: ${game.sourceUrl || getMLBSchedulePageUrl(this.currentDate)}`;

            const matchup = document.createElement('div');
            matchup.className = 'game-matchup';
            matchup.textContent = `${game.away} vs ${game.home}`;

            gameBox.appendChild(matchup);
            gameBox.onclick = () => this.selectGame(gameBox, index);
            
            gamesContainer.appendChild(gameBox);
        });
        
        // 5개 미만의 게임이 있을 때 가운데 정렬
        if (games.length < 5) {
            gamesContainer.classList.add('center-align');
        } else {
            gamesContainer.classList.remove('center-align');
        }
        
        this.totalGames = games.length; // 현재 날짜의 총 게임 수 설정
        this.currentPage = 0; // 게임 목록이 새로 로드될 때마다 첫 번째 페이지로 초기화
        this.updateGameDisplay();
        this.updatePagination();
        
        // 초기 상태 설정
        this.selectedGame = null;
        this.resetGameDetails();
        this.checkPitcherSelection();
    }
    
    updateGamesDisplay() {
        // 게임 목록 업데이트
        console.log('Updating games display');
    }
    
    // 테이블 데이터 업데이트 헬퍼 함수
    updateTableData(tableId, data) {
        const table = document.getElementById(tableId);
        if (!table) return;
        
        const tbody = table.querySelector('tbody');
        if (!tbody) return;
        
        tbody.innerHTML = '';
        
        data.forEach(rowData => {
            const row = document.createElement('tr');
            rowData.forEach((cellData, index) => {
                const cell = document.createElement('td');
                if (index === 0) cell.className = 'team-cell';
                if (index === 1) cell.className = 'name-cell';
                cell.textContent = cellData;
                row.appendChild(cell);
            });
            tbody.appendChild(row);
        });
        
        // 팀 셀 병합 다시 실행
        setTimeout(() => this.mergeTeamCells(), 100);
    }
    
    appendBattingLines(cell, values) {
        const lines = Array.isArray(values) ? values : [];
        lines.forEach((value, index) => {
            if (index > 0) {
                cell.appendChild(document.createElement('br'));
            }
            cell.appendChild(document.createTextNode(value));
        });
    }

    getCollectedBattingResults(value) {
        if (value && !Array.isArray(value) && value.qualified) {
            return [value];
        }
        if (Array.isArray(value)) {
            return value.filter(item => item && item.qualified);
        }
        return [];
    }

    // 새 Python 수집 결과를 팀별 한 행, 지표별 여러 줄로 표시
    renderCollectedBattingRecent(collectedResults) {
        const table = document.getElementById(MLB_TABLE_IDS.hittingRecent);
        const tbody = table ? table.querySelector('tbody') : null;
        if (!tbody) {
            return 0;
        }

        const results = this.getCollectedBattingResults(collectedResults);
        const statNames = ['AVG', 'OBP', 'SLG', 'OPS', 'RISP'];
        tbody.innerHTML = '';

        results.forEach(result => {
            const row = document.createElement('tr');
            const teamCell = document.createElement('td');
            teamCell.className = 'team-cell';
            teamCell.textContent = this.normalizeTeamAbbreviation(result.team) || '';
            row.appendChild(teamCell);

            statNames.forEach(statName => {
                const statCell = document.createElement('td');
                statCell.className = 'name-cell';
                this.appendBattingLines(statCell, result.qualified[statName]);
                row.appendChild(statCell);
            });

            tbody.appendChild(row);
        });

        const countFor = (result, statName) => {
            const values = result && result.qualified
                ? result.qualified[statName]
                : [];
            return Array.isArray(values) ? values.length : 0;
        };
        const awayResult = results[0] || null;
        const homeResult = results[1] || null;
        this.battingStatsData = {
            awayTeam: awayResult
                ? this.normalizeTeamAbbreviation(awayResult.team)
                : '',
            homeTeam: homeResult
                ? this.normalizeTeamAbbreviation(homeResult.team)
                : '',
            avg: { away: countFor(awayResult, 'AVG'), home: countFor(homeResult, 'AVG') },
            obp: { away: countFor(awayResult, 'OBP'), home: countFor(homeResult, 'OBP') },
            slg: { away: countFor(awayResult, 'SLG'), home: countFor(homeResult, 'SLG') },
            ops: { away: countFor(awayResult, 'OPS'), home: countFor(homeResult, 'OPS') },
            risp: { away: countFor(awayResult, 'RISP'), home: countFor(homeResult, 'RISP') }
        };
        return results.length;
    }

    // 타격 성적 테이블 업데이트
    updateBattingStatsTable(data) {
        const table = document.getElementById(MLB_TABLE_IDS.hittingRecent);
        if (!table) return;
        
        const tbody = table.querySelector('tbody');
        if (!tbody) return;
        
        tbody.innerHTML = '';
        
        data.forEach(teamData => {
            const row = document.createElement('tr');
            
            // Team
            const teamCell = document.createElement('td');
            teamCell.className = 'team-cell';
            teamCell.textContent = teamData.team;
            row.appendChild(teamCell);
            
            // AVG
            const avgCell = document.createElement('td');
            avgCell.className = 'name-cell';
            avgCell.innerHTML = teamData.avg.join('<br>');
            row.appendChild(avgCell);
            
            // OBP
            const obpCell = document.createElement('td');
            obpCell.className = 'name-cell';
            obpCell.innerHTML = teamData.obp.join('<br>');
            row.appendChild(obpCell);
            
            // SLG
            const slgCell = document.createElement('td');
            slgCell.className = 'name-cell';
            slgCell.innerHTML = teamData.slg.join('<br>');
            row.appendChild(slgCell);
            
            // OPS
            const opsCell = document.createElement('td');
            opsCell.className = 'name-cell';
            opsCell.innerHTML = teamData.ops.join('<br>');
            row.appendChild(opsCell);
            
            // RISP
            const rispCell = document.createElement('td');
            rispCell.className = 'name-cell';
            rispCell.innerHTML = teamData.risp.join('<br>');
            row.appendChild(rispCell);
            
            tbody.appendChild(row);
        });
    }
    
    // 최근 타격 성적 데이터를 테이블에 표시
    async loadBattingStats(jsonData14, jsonData15, awayTeamCode, homeTeamCode) {
        const collectedResults = this.getCollectedBattingResults(jsonData14);
        if (collectedResults.length > 0) {
            this.renderCollectedBattingRecent(collectedResults);
            return;
        }

        const battingStatsTable = document.getElementById(MLB_TABLE_IDS.hittingRecent);
        if (!battingStatsTable) {
            return;
        }

        const tbody = battingStatsTable.querySelector('tbody');
        if (!tbody) {
            return;
        }

        // 기존 행 제거
        tbody.innerHTML = '';

        // 팀명 약칭 정규화
        const normalizedAwayTeam = this.normalizeTeamAbbreviation(awayTeamCode);
        const normalizedHomeTeam = this.normalizeTeamAbbreviation(homeTeamCode);

        // 각 팀별로 데이터 처리
        const teams = [
            { code: awayTeamCode, normalized: normalizedAwayTeam },
            { code: homeTeamCode, normalized: normalizedHomeTeam }
        ];

        // 그래프를 위한 데이터 초기화
        const battingData = {
            away: { avg: 0, obp: 0, slg: 0, ops: 0, risp: 0 },
            home: { avg: 0, obp: 0, slg: 0, ops: 0, risp: 0 }
        };
        
        teams.forEach((team, teamIndex) => {
            // 해당 팀의 선수 데이터 필터링
            const teamPlayers = jsonData14.filter(item => {
                if (!item.Tm) return false;
                const normalizedTm = this.normalizeTeamAbbreviation(item.Tm);
                return this.compareTeamAbbreviations(team.normalized, normalizedTm);
            });

            // 조건에 맞는 선수 필터링
            const avgPlayers = [];
            const obpPlayers = [];
            const slgPlayers = [];
            const opsPlayers = [];

            teamPlayers.forEach(player => {
                // AVG >= 0.3
                if (player.AVG) {
                    const avgValue = parseFloat(player.AVG);
                    if (!isNaN(avgValue) && avgValue >= 0.3) {
                        avgPlayers.push(player.Name || '');
                    }
                }

                // OBP >= 0.4
                if (player.OBP) {
                    const obpValue = parseFloat(player.OBP);
                    if (!isNaN(obpValue) && obpValue >= 0.4) {
                        obpPlayers.push(player.Name || '');
                    }
                }

                // SLG >= 0.5
                if (player.SLG) {
                    const slgValue = parseFloat(player.SLG);
                    if (!isNaN(slgValue) && slgValue >= 0.5) {
                        slgPlayers.push(player.Name || '');
                    }
                }

                // OPS >= 0.9
                if (player.OPS) {
                    const opsValue = parseFloat(player.OPS);
                    if (!isNaN(opsValue) && opsValue >= 0.9) {
                        opsPlayers.push(player.Name || '');
                    }
                }
            });

            // RISP: jsonData15에서 AVG >= 0.3인 선수 찾기
            const rispPlayers = [];
            const teamRispPlayers = jsonData15.filter(item => {
                if (!item.Tm) return false;
                const normalizedTm = this.normalizeTeamAbbreviation(item.Tm);
                return this.compareTeamAbbreviations(team.normalized, normalizedTm);
            });

            teamRispPlayers.forEach(player => {
                if (player.AVG) {
                    const avgValue = parseFloat(player.AVG);
                    if (!isNaN(avgValue) && avgValue >= 0.3) {
                        rispPlayers.push(player.Name || '');
                    }
                }
            });
            
            // 그래프 데이터 저장 (teamIndex 0 = away, 1 = home)
            const dataKey = teamIndex === 0 ? 'away' : 'home';
            battingData[dataKey].avg = avgPlayers.length;
            battingData[dataKey].obp = obpPlayers.length;
            battingData[dataKey].slg = slgPlayers.length;
            battingData[dataKey].ops = opsPlayers.length;
            battingData[dataKey].risp = rispPlayers.length;

            // 행 생성
            const row = document.createElement('tr');
            
            // Team
            const teamCell = document.createElement('td');
            teamCell.className = 'team-cell';
            teamCell.textContent = team.code;
            row.appendChild(teamCell);

            // AVG
            const avgCell = document.createElement('td');
            avgCell.className = 'name-cell';
            avgCell.innerHTML = avgPlayers.join('<br>');
            row.appendChild(avgCell);

            // OBP
            const obpCell = document.createElement('td');
            obpCell.className = 'name-cell';
            obpCell.innerHTML = obpPlayers.join('<br>');
            row.appendChild(obpCell);

            // SLG
            const slgCell = document.createElement('td');
            slgCell.className = 'name-cell';
            slgCell.innerHTML = slgPlayers.join('<br>');
            row.appendChild(slgCell);

            // OPS
            const opsCell = document.createElement('td');
            opsCell.className = 'name-cell';
            opsCell.innerHTML = opsPlayers.join('<br>');
            row.appendChild(opsCell);

            // RISP
            const rispCell = document.createElement('td');
            rispCell.className = 'name-cell';
            rispCell.innerHTML = rispPlayers.join('<br>');
            row.appendChild(rispCell);

            tbody.appendChild(row);
        });

        // 같은 팀명 병합
        this.mergeTeamCells(tbody);
        
        // 그래프를 위한 데이터 저장
        this.battingStatsData = {
            awayTeam: awayTeamCode,
            homeTeam: homeTeamCode,
            avg: { away: battingData.away.avg, home: battingData.home.avg },
            obp: { away: battingData.away.obp, home: battingData.home.obp },
            slg: { away: battingData.away.slg, home: battingData.home.slg },
            ops: { away: battingData.away.ops, home: battingData.home.ops },
            risp: { away: battingData.away.risp, home: battingData.home.risp }
        };

        console.log(`Batting stats loaded for ${awayTeamCode} and ${homeTeamCode}`);
    }
    
    // 타격 성적 비교 차트 표시 (모든 통계를 한 번에)
    showBattingComparisonChartFromElement(targetEl, statName) {
        if (!targetEl || !statName || statName === 'Team') return;
        if (!this.battingStatsData) return;
        
        const battingStatsTable = document.getElementById(MLB_TABLE_IDS.hittingRecent);
        const tbody = battingStatsTable ? battingStatsTable.querySelector('tbody') : null;
        const rows = tbody ? tbody.querySelectorAll('tr') : [];
        
        if (rows.length < 2) return;
        
        const awayTeam = this.battingStatsData.awayTeam;
        const homeTeam = this.battingStatsData.homeTeam;
        
        // 모든 통계 헤더 가져오기
        const headers = battingStatsTable.querySelectorAll('thead th.chart-hoverable');
        const stats = [];
        const awayValues = [];
        const homeValues = [];
        
        headers.forEach((header) => {
            const stat = header.getAttribute('data-stat');
            if (!stat) return;
            
            let awayCount = 0;
            let homeCount = 0;
            
            switch(stat) {
                case 'AVG':
                    awayCount = this.battingStatsData.avg.away;
                    homeCount = this.battingStatsData.avg.home;
                    break;
                case 'OBP':
                    awayCount = this.battingStatsData.obp.away;
                    homeCount = this.battingStatsData.obp.home;
                    break;
                case 'SLG':
                    awayCount = this.battingStatsData.slg.away;
                    homeCount = this.battingStatsData.slg.home;
                    break;
                case 'OPS':
                    awayCount = this.battingStatsData.ops.away;
                    homeCount = this.battingStatsData.ops.home;
                    break;
                case 'RISP':
                    awayCount = this.battingStatsData.risp.away;
                    homeCount = this.battingStatsData.risp.home;
                    break;
                default:
                    return;
            }
            
            if (awayCount >= 0 && homeCount >= 0) {
                stats.push(stat);
                awayValues.push(awayCount);
                homeValues.push(homeCount);
            }
        });
        
        if (stats.length === 0) return;
        
        // 차트 위치 설정 (테이블 위쪽에 표시)
        const rect = targetEl.getBoundingClientRect();
        const tableRect = battingStatsTable.getBoundingClientRect();
        this.battingChartTooltip.style.display = 'block';
        this.battingChartTooltip.style.position = 'fixed';
        this.battingChartTooltip.style.left = `${rect.left + rect.width / 2}px`;
        this.battingChartTooltip.style.top = `${tableRect.top - 350}px`; // 테이블 위쪽에 표시
        this.battingChartTooltip.style.transform = 'translateX(-50%)';
        
        // 차트 생성 (모든 통계)
        this.createBattingComparisonChart(stats, awayTeam, homeTeam, awayValues, homeValues);
    }
    
    // 타격 성적 비교 차트 생성 (모든 통계)
    createBattingComparisonChart(stats, awayTeam, homeTeam, awayValues, homeValues) {
        const canvas = document.getElementById('battingComparisonChart');
        if (!canvas) return;
        
        // 기존 차트가 있으면 제거
        if (this.battingComparisonChart) {
            this.battingComparisonChart.destroy();
        }
        
        // 각 통계별로 값 정규화 (합이 100이 되도록) - 선발투수 테이블과 동일한 방식
        const awayPercents = [];
        const homePercents = [];
        const originalAwayValues = [];
        const originalHomeValues = [];
        
        stats.forEach((stat, index) => {
            const awayValue = awayValues[index];
            const homeValue = homeValues[index];
            const total = awayValue + homeValue;
            
            const awayPercent = total > 0 ? (awayValue / total) * 100 : 50;
            const homePercent = total > 0 ? (homeValue / total) * 100 : 50;
            
            awayPercents.push(awayPercent);
            homePercents.push(homePercent);
            originalAwayValues.push(awayValue);
            originalHomeValues.push(homeValue);
        });
        
        // 차트 생성
        const ctx = canvas.getContext('2d');
        this.battingComparisonChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: stats,
                datasets: [
                    {
                        label: awayTeam,
                        data: awayPercents,
                        backgroundColor: 'rgba(255, 159, 64, 0.8)',
                        borderColor: 'rgba(255, 159, 64, 1)',
                        borderWidth: 1
                    },
                    {
                        label: homeTeam,
                        data: homePercents,
                        backgroundColor: 'rgba(128, 0, 128, 0.8)',
                        borderColor: 'rgba(128, 0, 128, 1)',
                        borderWidth: 1
                    }
                ]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: true,
                        position: 'top'
                    },
                    tooltip: {
                        callbacks: {
                            label: (context) => {
                                const datasetIndex = context.datasetIndex;
                                const dataIndex = context.dataIndex;
                                const percent = context.dataset.data[dataIndex];
                                const originalValue = datasetIndex === 0 
                                    ? originalAwayValues[dataIndex] 
                                    : originalHomeValues[dataIndex];
                                const statName = stats[dataIndex];
                                
                                return `${context.dataset.label}: ${originalValue}명 (${percent.toFixed(1)}%)`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        stacked: true,
                        max: 100,
                        ticks: {
                            callback: function(value) {
                                return value + '%';
                            }
                        }
                    },
                    y: {
                        stacked: true
                    }
                }
            }
        });
    }
    
    // 타격 성적 비교 차트 숨기기
    hideBattingComparisonChart() {
        if (this.battingChartTooltip) {
            this.battingChartTooltip.style.display = 'none';
        }
        if (this.battingComparisonChart) {
            this.battingComparisonChart.destroy();
            this.battingComparisonChart = null;
        }
    }
    
    // 투수 정보 업데이트
    updatePitcherInfo(team, selectedPitcher, pitcherList) {
        const pitcherBox = document.getElementById(`${team}PitcherBox`);
        const dropdown = document.getElementById(`${team}PitcherDropdown`);
        
        if (pitcherBox) {
            pitcherBox.textContent = selectedPitcher;
        }
        
        if (dropdown) {
            dropdown.innerHTML = '';
            pitcherList.forEach(pitcher => {
                const option = document.createElement('div');
                option.className = 'pitcher-option';
                option.textContent = pitcher;
                option.onclick = () => this.selectPitcher(team, pitcher);
                dropdown.appendChild(option);
            });
        }
    }
    
    // 모든 테이블 비우기 (투수 드롭다운은 유지)
    clearAllTables() {
        const tableIds = Object.values(MLB_TABLE_IDS);
        
        tableIds.forEach(tableId => {
            const table = document.getElementById(tableId);
            if (table) {
                const tbody = table.querySelector('tbody');
                if (tbody) {
                    tbody.innerHTML = '';
                }
            }
        });
        
        // 투수 선택 상태 초기화 (드롭다운 목록은 유지)
        const awayPitcherBox = document.getElementById('awayPitcherBox');
        const homePitcherBox = document.getElementById('homePitcherBox');
        if (awayPitcherBox) {
            awayPitcherBox.textContent = '선발투수 선택';
        }
        if (homePitcherBox) {
            homePitcherBox.textContent = '선발투수 선택';
        }
    }

    // 유틸리티 함수들
    formatDate(date) {
        const year = date.getFullYear();
        const month = date.getMonth() + 1;
        const day = date.getDate();
        const dayNames = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
        const dayName = dayNames[date.getDay()];
        
        return `${year}년 ${month}월 ${day}일 ${dayName}`;
    }
    
    getCurrentDate() {
        return new Date(this.currentDate);
    }
    
    setCurrentDate(date) {
        this.currentDate = new Date(date);
        this.updateDateDisplay();
    }
    
    // 팀 셀 병합 함수
    mergeTeamCells() {
        const tables = document.querySelectorAll('.stats-table');
        
        tables.forEach(table => {
            const rows = table.querySelectorAll('tbody tr');
            const teamCells = Array.from(rows).map(row => row.querySelector('.team-cell'));
            
            let currentTeam = null;
            let startRow = 0;
            let mergeCount = 0;
            
            teamCells.forEach((cell, index) => {
                const teamName = cell ? cell.textContent.trim() : '';
                
                if (teamName === currentTeam) {
                    mergeCount++;
                } else {
                    // 이전 팀이 있었다면 병합 처리
                    if (currentTeam && mergeCount > 1) {
                        this.mergeCellsInRange(rows, startRow, mergeCount, 0);
                    }
                    
                    // 새로운 팀 시작
                    currentTeam = teamName;
                    startRow = index;
                    mergeCount = 1;
                }
            });
            
            // 마지막 팀 처리
            if (currentTeam && mergeCount > 1) {
                this.mergeCellsInRange(rows, startRow, mergeCount, 0);
            }
        });
    }
    
    // 지정된 범위의 셀들을 병합하는 함수
    mergeCellsInRange(rows, startIndex, count, cellIndex) {
        if (count <= 1) return;
        
        const firstRow = rows[startIndex];
        const firstCell = firstRow.cells[cellIndex];
        
        // 첫 번째 셀에 rowspan 설정
        firstCell.rowSpan = count;
        
        // 나머지 셀들 제거
        for (let i = startIndex + 1; i < startIndex + count; i++) {
            const row = rows[i];
            if (row && row.cells[cellIndex]) {
                row.cells[cellIndex].remove();
            }
        }
    }
}

let mlbFrontend;

// 1. changeDate(-1)
// 2. toggleCalendar()  
// 3. changeDate(1) 
// 4. changeMonth(-1) 
// 5. changeMonth(1)  
// 6. selectGame(this, 0~14)

function changeDate(direction) {
    if (mlbFrontend) {
        mlbFrontend.changeDate(direction);
    }
}

function toggleCalendar() {
    if (mlbFrontend) {
        mlbFrontend.toggleCalendar();
    }
}

function changeMonth(direction) {
    if (mlbFrontend) {
        mlbFrontend.changeMonth(direction);
    }
}

function selectGame(gameBox, gameIndex) {
    if (mlbFrontend) {
        mlbFrontend.selectGame(gameBox, gameIndex);
    }
}

function togglePitcherDropdown(team) {
    if (mlbFrontend) {
        mlbFrontend.togglePitcherDropdown(team);
    }
}

function selectPitcher(team, pitcherName) {
    if (mlbFrontend) {
        mlbFrontend.selectPitcher(team, pitcherName);
    }
}

// DOM 로드 완료 시 초기화
document.addEventListener('DOMContentLoaded', function() {
    mlbFrontend = new MLBFrontend();
    window.mlbFrontend = mlbFrontend;
});

// 전역으로 노출 (디버깅용)
window.MLBFrontend = MLBFrontend;
window.MLB_TABLE_IDS = MLB_TABLE_IDS;
window.mlbFrontend = mlbFrontend;
