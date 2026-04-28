document.addEventListener('DOMContentLoaded', () => {
    const taskNameInput = document.getElementById('task-name');
    const taskCategorySelect = document.getElementById('task-category');
    const startTimerBtn = document.getElementById('start-timer');
    const stopTimerBtn = document.getElementById('stop-timer');
    const currentTaskDisplay = document.getElementById('current-task-display');
    const elapsedTimeDisplay = document.getElementById('elapsed-time');
    const tasksUl = document.getElementById('tasks-ul');
    const statsChartCanvas = document.getElementById('stats-chart');
    const statsSummary = document.getElementById('stats-summary');
    const statsExtra = document.getElementById('stats-extra');
    const manualNameInput = document.getElementById('manual-task-name');
    const manualCategorySelect = document.getElementById('manual-task-category');
    const manualDurationInput = document.getElementById('manual-task-duration');
    const addTaskBtn = document.getElementById('add-task');
    const saveTemplateBtn = document.getElementById('save-template');
    const clearTasksBtn = document.getElementById('clear-tasks');
    const themeSelect = document.getElementById('theme-select');
    const resetAppBtn = document.getElementById('reset-app');

    let currentTask = null;
    let startTime = null;
    let timerInterval = null;
    let tasks = JSON.parse(localStorage.getItem('tasks')) || [];
    let templates = JSON.parse(localStorage.getItem('templates')) || [];
    let statsChart = null;
    let theme = localStorage.getItem('theme') || 'default';

    function updateDisplay() {
        if (currentTask) {
            currentTaskDisplay.textContent = `${currentTask.name} (${currentTask.category})`;
        } else {
            currentTaskDisplay.textContent = 'No task running';
            elapsedTimeDisplay.textContent = '00:00:00';
        }
        renderTemplates();
        renderTasks();
        renderStats();
        applyTheme();
    }

    function switchPage(pageId) {
        document.querySelectorAll('.page').forEach(page => page.classList.toggle('active', page.id === pageId));
        document.querySelectorAll('.page-nav button').forEach(button => button.classList.toggle('active', button.dataset.page === pageId));
        window.location.hash = pageId;
    }

    function loadPageFromHash() {
        const hashPage = window.location.hash.replace('#', '');
        const pageExists = !!document.getElementById(hashPage);
        switchPage(pageExists ? hashPage : 'timer-page');
    }

    function saveState() {
        localStorage.setItem('tasks', JSON.stringify(tasks));
        localStorage.setItem('templates', JSON.stringify(templates));
        localStorage.setItem('theme', theme);
    }

    function formatDuration(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        return `${hours}h ${minutes}m ${secs}s`;
    }

    function startTimer() {
        const name = taskNameInput.value.trim();
        if (!name) return alert('Enter task name');
        const selectedTemplate = templates.find(item => item.id === templateSelect.value);
        currentTask = { name, category: taskCategorySelect.value };
        if (selectedTemplate) {
            currentTask.name = selectedTemplate.name;
            currentTask.category = selectedTemplate.category;
        }
        startTime = Date.now();
        startTimerBtn.disabled = true;
        stopTimerBtn.disabled = false;
        timerInterval = setInterval(updateElapsedTime, 1000);
        updateDisplay();
    }

    function stopTimer() {
        if (!currentTask) return;
        const endTime = Date.now();
        const duration = Math.floor((endTime - startTime) / 1000);
        currentTask.duration = duration;
        currentTask.date = new Date().toISOString();
        tasks.unshift(currentTask);
        saveState();
        currentTask = null;
        startTime = null;
        clearInterval(timerInterval);
        startTimerBtn.disabled = false;
        stopTimerBtn.disabled = true;
        updateDisplay();
    }

    function updateElapsedTime() {
        if (!startTime) return;
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        elapsedTimeDisplay.textContent = new Date(elapsed * 1000).toISOString().substr(11, 8);
    }

    function createManualTask() {
        const name = manualNameInput.value.trim();
        if (!name) return alert('Enter task name');
        const durationMinutes = parseFloat(manualDurationInput.value);
        const duration = Number.isFinite(durationMinutes) && durationMinutes >= 0 ? Math.round(durationMinutes * 60) : 0;
        const task = {
            id: crypto.randomUUID(),
            name,
            category: manualCategorySelect.value,
            duration,
            date: new Date().toISOString()
        };
        tasks.unshift(task);
        manualNameInput.value = '';
        manualDurationInput.value = '';
        saveState();
        updateDisplay();
    }

    function saveTemplate() {
        const name = manualNameInput.value.trim();
        if (!name) return alert('Enter template name');
        const template = {
            id: crypto.randomUUID(),
            name,
            category: manualCategorySelect.value
        };
        templates.unshift(template);
        manualNameInput.value = '';
        saveState();
        updateDisplay();
    }

    function deleteTask(index) {
        tasks.splice(index, 1);
        saveState();
        updateDisplay();
    }

    function deleteTemplate(index) {
        templates.splice(index, 1);
        saveState();
        updateDisplay();
    }

    function clearTasks() {
        if (!confirm('Clear all completed tasks?')) return;
        tasks = [];
        saveState();
        updateDisplay();
    }

    function applyTheme() {
        document.body.dataset.theme = theme;
        themeSelect.value = theme;
    }

    function renderTemplates() {
        templateSelect.innerHTML = '<option value="">Start from saved template</option>';
        templates.forEach(template => {
            const option = document.createElement('option');
            option.value = template.id;
            option.textContent = `${template.name} (${template.category})`;
            templateSelect.appendChild(option);
        });
        templatesUl.innerHTML = '';
        templates.forEach((template, index) => {
            const li = document.createElement('li');
            li.className = 'task-row';
            li.innerHTML = `
                <span>${template.name} (${template.category})</span>
                <button type="button" class="small-button" data-action="delete-template" data-index="${index}">Delete</button>
            `;
            templatesUl.appendChild(li);
        });
    }

    function renderTasks() {
        tasksUl.innerHTML = '';
        if (tasks.length === 0) {
            tasksUl.innerHTML = '<li class="empty">No tasks yet.</li>';
            return;
        }
        tasks.forEach((task, index) => {
            const li = document.createElement('li');
            li.className = 'task-row';
            li.innerHTML = `
                <div>
                    <strong>${task.name}</strong><br>
                    <span>${task.category} • ${formatDuration(task.duration)}</span>
                </div>
                <button type="button" class="small-button" data-action="delete-task" data-index="${index}">Delete</button>
            `;
            tasksUl.appendChild(li);
        });
    }

    function renderStats() {
        const categoryTotals = {};
        let totalTime = 0;
        tasks.forEach(task => {
            categoryTotals[task.category] = (categoryTotals[task.category] || 0) + task.duration;
            totalTime += task.duration;
        });
        statsSummary.innerHTML = `
            <p><strong>Total Time</strong>: ${formatDuration(totalTime)}</p>
            <p><strong>Sessions</strong>: ${tasks.length}</p>
        `;
        const topCategories = Object.entries(categoryTotals)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([category, total]) => `<li>${category}: ${formatDuration(total)}</li>`)
            .join('');
        statsExtra.innerHTML = topCategories ? `
            <div class="stats-details">
                <h3>Top Categories</h3>
                <ul>${topCategories}</ul>
            </div>
        ` : '<p>No data yet.</p>';
        const labels = Object.keys(categoryTotals);
        const values = Object.values(categoryTotals);
        if (statsChart) {
            statsChart.destroy();
        }
        const ctx = statsChartCanvas.getContext('2d');
        statsChart = new Chart(ctx, {
            type: 'pie',
            data: {
                labels,
                datasets: [{
                    data: values,
                    backgroundColor: ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#8E44AD', '#2ECC71']
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { position: 'bottom' },
                    title: { display: true, text: 'Time by Category' }
                }
            }
        });
    }

    pageButtons.forEach(button => {
        button.addEventListener('click', () => switchPage(button.dataset.page));
    });

    templateSelect.addEventListener('change', () => {
        const selectedTemplate = templates.find(item => item.id === templateSelect.value);
        if (selectedTemplate) {
            taskNameInput.value = selectedTemplate.name;
            taskCategorySelect.value = selectedTemplate.category;
        }
    });

    addTaskBtn.addEventListener('click', createManualTask);
    saveTemplateBtn.addEventListener('click', saveTemplate);
    clearTasksBtn.addEventListener('click', clearTasks);
    themeSelect.addEventListener('change', () => {
        theme = themeSelect.value;
        saveState();
        applyTheme();
    });
    resetAppBtn.addEventListener('click', () => {
        if (!confirm('Reset all app data? This removes tasks, templates, and preferences.')) return;
        tasks = [];
        templates = [];
        theme = 'default';
        saveState();
        updateDisplay();
        switchPage('timer-page');
    });

    document.body.addEventListener('click', event => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const index = Number(button.dataset.index);
        if (button.dataset.action === 'delete-task') {
            deleteTask(index);
        } else if (button.dataset.action === 'delete-template') {
            deleteTemplate(index);
        }
    });

    loadPageFromHash();
    updateDisplay();
});

// Register service worker
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js');
}