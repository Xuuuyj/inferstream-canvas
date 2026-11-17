"use client";

import { useEffect, useRef, useState } from "react";
import { Carousel, type GetRef } from "antd";
import { Megaphone, X } from "lucide-react";

import { ANNOUNCEMENTS } from "@/constant/promo";

const DISMISSED_KEY = "fit:announcement-dismissed:v1";

export function AnnouncementBanner() {
    const [visible, setVisible] = useState(false);
    const [slide, setSlide] = useState({ index: 0, direction: "right" });
    const [paused, setPaused] = useState(false);
    const carouselRef = useRef<GetRef<typeof Carousel>>(null);

    useEffect(() => {
        try {
            setVisible(localStorage.getItem(DISMISSED_KEY) !== "1");
        } catch {
            setVisible(true);
        }
    }, []);

    if (!visible || !ANNOUNCEMENTS.length) return null;

    return (
        <section
            aria-label="站点公告"
            className="relative min-h-12 w-full shrink-0 bg-black text-white dark:bg-white dark:text-black"
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
            onFocus={() => setPaused(true)}
            onBlur={() => setPaused(false)}
        >
            <Carousel
                ref={carouselRef}
                autoplay={ANNOUNCEMENTS.length > 1 && !paused}
                autoplaySpeed={5000}
                effect="fade"
                speed={0}
                beforeChange={(_, next) => setSlide((current) => current.index === next ? current : { index: next, direction: "right" })}
                adaptiveHeight
                dots={false}
                rootClassName="isolate text-inherit!"
            >
                {ANNOUNCEMENTS.map(({ text, linkText, url }, index) => (
                    <div key={index}>
                        <div className={`flex min-h-12 items-center justify-center gap-2 px-12 py-2 text-center text-sm duration-300 in-[.slick-active]:animate-in in-[.slick-active]:fade-in sm:text-base ${slide.direction === "left" ? "in-[.slick-active]:slide-in-from-left-2" : "in-[.slick-active]:slide-in-from-right-2"}`}>
                            <span className="min-w-0 break-words font-medium leading-[1.6] [&_a]:whitespace-nowrap [&_svg]:mr-2 [&_svg]:inline-block [&_svg]:size-[18px] [&_svg]:align-middle [&_svg]:-translate-y-[2.5px]"><Megaphone />{text} <a href={url} target="_blank" rel="noopener" className="text-inherit! underline!">{linkText}</a></span>
                        </div>
                    </div>
                ))}
            </Carousel>
            {ANNOUNCEMENTS.length > 1 && (
                <div aria-label="选择公告" className="group/indicators absolute bottom-px left-1/2 flex max-w-40 -translate-x-1/2">
                    {ANNOUNCEMENTS.map((_, index) => (
                        <button
                            key={index}
                            type="button"
                            aria-label={`显示第 ${index + 1} 条公告`}
                            aria-current={slide.index === index ? true : undefined}
                            className={`group/item flex h-2.5 shrink cursor-pointer items-end justify-center rounded-sm px-1 pb-0.5 transition-[width] duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current ${slide.index === index ? "w-9" : "w-5"}`}
                            onClick={() => {
                                if (index === slide.index) return;
                                setSlide({ index, direction: index < slide.index ? "left" : "right" });
                                carouselRef.current?.goTo(index);
                            }}
                        >
                            <span className={`h-0.5 w-full rounded-full transition-[height,background-color] duration-150 group-hover/indicators:h-1.5 ${slide.index === index ? "bg-white dark:bg-black" : "bg-white/30 group-hover/item:bg-white/60 dark:bg-black/20 dark:group-hover/item:bg-black/50"}`} />
                        </button>
                    ))}
                </div>
            )}
            <button
                type="button"
                aria-label="关闭公告"
                className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer rounded-md p-1.5 hover:bg-white/15 dark:hover:bg-black/10 sm:right-4"
                onClick={() => {
                    setVisible(false);
                    try {
                        localStorage.setItem(DISMISSED_KEY, "1");
                    } catch {}
                }}
            >
                <X className="size-4" />
            </button>
        </section>
    );
}
