import { Dithering } from "@paper-design/shaders-react";
import { useEffect, useState } from "react";

interface HeroDitherProps {
	variant?: "main" | "gutter";
}

export default function HeroDither({ variant = "main" }: HeroDitherProps) {
	const isGutter = variant === "gutter";
	const [gutterAccent, setGutterAccent] = useState<string | null>(null);

	useEffect(() => {
		if (!isGutter) return;

		const accent = getComputedStyle(document.body).getPropertyValue("--accent").trim();
		if (accent) setGutterAccent(accent);
	}, [isGutter]);

	if (isGutter && !gutterAccent) return null;

	return (
		<Dithering
			aria-hidden="true"
			colorBack={isGutter ? gutterAccent! : "#191a20"}
			colorFront={isGutter ? "#000000" : "#303349"}
			fit="cover"
			frame={0}
			height="100%"
			maxPixelCount={isGutter ? 518_400 : 2_073_600}
			minPixelRatio={isGutter ? 1 : 2}
			offsetX={0}
			offsetY={0}
			rotation={0}
			scale={1}
			shape="ripple"
			size={3}
			speed={0.18}
			style={{ height: "100%", width: "100%" }}
			type="8x8"
			width="100%"
			worldHeight={560}
			worldWidth={1280}
		/>
	);
}
