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

    let currentTask = null;
    let startTime = null;
    let timerInterval = null;
    let tasks = JSON.parse(localStorage.getItem('tasks')) || [];

    function updateDisplay() {
        if (currentTask) {
            currentTaskDisplay.textContent = `${currentTask.name} (${currentTask.category})`;
        } else {
            currentTaskDisplay.textContent = 'No task running';
            elapsedTimeDisplay.textContent = '00:00:00';
        }
        renderTasks();
        renderStats();
    }

    function startTimer() {
        const name = taskNameInput.value.trim();
        if (!name) return alert('Enter task name');
        currentTask = { name, category: taskCategorySelect.value };
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
        tasks.push(currentTask);
        localStorage.setItem('tasks', JSON.stringify(tasks));
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
        const hours = Math.floor(elapsed / 3600).toString().padStart(2, '0');
        const minutes = Math.floor((elapsed % 3600) / 60).toString().padStart(2, '0');
        const seconds = (elapsed % 60).toString().padStart(2, '0');
        elapsedTimeDisplay.textContent = `${hours}:${minutes}:${seconds}`;
    }

    function renderTasks() {
        tasksUl.innerHTML = '';
        tasks.forEach(task => {
            const li = document.createElement('li');
            const hours = Math.floor(task.duration / 3600);
            const minutes = Math.floor((task.duration % 3600) / 60);
            const seconds = task.duration % 60;
            li.textContent = `${task.name} (${task.category}) - ${hours}h ${minutes}m ${seconds}s`;
            tasksUl.appendChild(li);
        });
    }

    function renderStats() {
        const categoryTotals = {};
        let totalTime = 0;
        tasks.forEach(task => {
            if (!categoryTotals[task.category]) categoryTotals[task.category] = 0;
            categoryTotals[task.category] += task.duration;
            totalTime += task.duration;
        });

        statsSummary.innerHTML = `<p>Total Time: ${Math.floor(totalTime / 3600)}h ${Math.floor((totalTime % 3600) / 60)}m ${totalTime % 60}s</p>`;

        const ctx = statsChartCanvas.getContext('2d');
        new Chart(ctx, {
            type: 'pie',
            data: {
                labels: Object.keys(categoryTotals),
                datasets: [{
                    data: Object.values(categoryTotals),
                    backgroundColor: ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0']
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: {
                        position: 'top',
                    },
                    title: {
                        display: true,
                        text: 'Time by Category'
                    }
                }
            }
        });
    }

    startTimerBtn.addEventListener('click', startTimer);
    stopTimerBtn.addEventListener('click', stopTimer);

    updateDisplay();
});

// Register service worker
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js');
}