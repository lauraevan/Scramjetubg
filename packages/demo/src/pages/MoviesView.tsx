import { css, type Component } from "dreamland/core";

const MoviesView: Component = function () {
	return (
		<div class="movies-view">
			<div class="movies-content">
				<h1>Movies</h1>
				<p>Movie library coming soon.</p>
			</div>
		</div>
	);
};

MoviesView.style = css`
	:scope {
		width: 100%;
		height: 100%;
		background: #0f0f0f;
		color: #e5e7eb;
		overflow: auto;
	}

	.movies-content {
		padding: 28px;
	}

	h1 {
		margin: 0 0 8px;
		font-size: 1.4rem;
		font-weight: 650;
	}

	p {
		margin: 0;
		color: #8f8f8f;
		font-size: 0.9rem;
	}
`;

export default MoviesView;
