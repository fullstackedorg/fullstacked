import "./index.css";

document.body.innerHTML =
    "<div class='bg-red-500 w-full h-full text-right'></div>";

setTimeout(() => {
    document.body.classList.add("done");
}, 1000);