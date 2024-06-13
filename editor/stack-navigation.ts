class StackNavigation {
    private views: HTMLElement[] = [];

    lock = false;

    leftInit = 50;
    velocityThreshold = 1;

    behindViewOffset = 0.3;

    constructor() {
        window.addEventListener("touchstart", this.onStart.bind(this));
        window.addEventListener("touchmove", this.onMove.bind(this));
        window.addEventListener("touchend", this.onEnd.bind(this));
    }

    private drag: {
        id: number;
        start: {
            x: number;
            timestamp: number;
        };
        end: {
            x: number;
            timestamp: number;
        };
    } = null;
    onStart(e: TouchEvent) {
        if (this.views.length <= 1 || e.touches.length > 1 || this.lock) return;

        const start = e.touches.item(0).clientX;

        if (start > this.leftInit) return;

        this.drag = {
            id: e.touches.item(0).identifier,
            start: {
                x: start,
                timestamp: Date.now()
            },
            end: {
                x: start,
                timestamp: Date.now()
            }
        };
        const currentView = this.views.at(-1);
        currentView.style.transition = "none";
        currentView.style.transform = `translate3d(0px, 0px, 0px)`;
        currentView.classList.add("navigating");
        (currentView.children[0] as HTMLElement).style.overflow = "hidden";

        this.views.at(-2).style.transition = "none";
    }
    onMove(e: TouchEvent) {
        if (this.drag === null) return;

        let draggingTouch: Touch;
        for (let i = 0; i < e.touches.length; i++) {
            const touch = e.touches.item(i);
            if (touch.identifier === this.drag.id) {
                draggingTouch = touch;
                break;
            }
        }

        if (!draggingTouch) {
            this.onEnd(e);
            return;
        }

        this.drag.end = {
            x: draggingTouch.clientX,
            timestamp: Date.now()
        };
        let deltaX = this.drag.end.x - this.drag.start.x;

        this.views.at(-1).style.transform =
            `translate3d(${deltaX > 0 ? deltaX : 0}px, 0px, 0px)`;

        const percentX = deltaX / window.innerWidth;
        const deltaBehindViewPercent = this.behindViewOffset * percentX;
        const translationX =
            (this.behindViewOffset - deltaBehindViewPercent) * 100;
        this.views.at(-2).style.transform =
            `translate3d(-${translationX > 0 ? translationX : 0}%, 0px, 0px)`;
    }
    onEnd(e: TouchEvent) {
        if (this.drag === null) return;

        let stillDragging = false;
        for (let i = 0; i < e.touches.length; i++) {
            const touch = e.touches.item(i);
            if (touch.identifier === this.drag.id) {
                stillDragging = true;
                break;
            }
        }

        if (stillDragging) return;

        const deltaTime = this.drag.end.timestamp - this.drag.start.timestamp;
        const deltaX = this.drag.end.x - this.drag.start.x;

        const velocity = deltaX / deltaTime;

        if (
            velocity > this.velocityThreshold ||
            this.drag.end.x > window.innerWidth * 0.5
        ) {
            this.back();
        } else {
            const currentView = this.views.at(-1);
            currentView.style.transition = "0.3s transform";
            currentView.style.transform = `translate3d(0px, 0px, 0px)`;
            currentView.classList.remove("navigating");
            (currentView.children[0] as HTMLElement).style.overflow = "auto";

            const behindView = this.views.at(-2);
            behindView.style.transition = "0.3s transform";
            behindView.style.transform = `translate3d(-${this.behindViewOffset * 100}%, 0px, 0px)`;
        }

        this.drag = null;
    }

    navigate(e: HTMLElement, color: string) {
        const view = document.createElement("div");
        view.style.backgroundColor = color;
        view.classList.add("view");
        view.style.transition = `0.3s transform`;
        view.style.transform = `translate3d(100%, 0px, 0px)`;

        const inner = document.createElement("div");
        inner.append(e);

        view.append(inner);

        this.views.forEach((v) => {
            v.style.pointerEvents = "none";
            v.style.transition = `0.3s 1ms transform`;
            v.style.transform = `translate3d(-${this.behindViewOffset * 100}%, 0px, 0px)`;
        });

        this.views.push(view);
        document.body.append(view);

        setTimeout(() => {
            if (this.views.at(-1) === view)
                view.style.transform = `translate3d(0%, 0px, 0px)`;
        }, 1);
    }

    isBackAvailable() {}
    back() {
        const lastView = this.views.pop();
        lastView.style.transition = "0.3s transform";
        lastView.style.transform = `translate3d(${window.innerWidth}px, 0px, 0px)`;
        setTimeout(() => lastView.remove(), 400);

        const currentView = this.views.at(-1);
        currentView.style.transition = "0.3s transform";
        currentView.style.pointerEvents = "all";
        currentView.style.transform = `translate3d(0%, 0px, 0px)`;
    }

    reset() {
        while (this.views.length > 0) {
            this.views.pop().remove();
        }
    }
}

export default new StackNavigation();
