using UnityEngine;
using SkillApp.ChickenRun.View;
using SkillApp.PopShot.Simulation;

namespace SkillApp.PopShot.View
{
    /// <summary>
    /// Renders the Pop Shot court from simulation state.
    ///
    /// Owns no rules. It reads Sim.State and draws it, and the only numbers it
    /// invents are the ones between two ticks — the interpolation that makes 50Hz
    /// logic look smooth at 120fps.
    ///
    /// ── The wrap has to be drawn twice ───────────────────────────────────────
    ///
    /// The ball wraps at the court edges, which is a hard cut in world space and
    /// would read as the ball teleporting. So a second ball is drawn one court
    /// width away, and near an edge both are on screen: one leaving, one already
    /// arriving. It costs one extra cube and turns the game's strangest mechanic
    /// into something a player reads instantly.
    /// </summary>
    public class PopShotView : MonoBehaviour
    {
        [SerializeField] private PopShotGame game;
        [SerializeField] private new Camera camera;
        [SerializeField] private Material boardMaterial;

        [Header("Palette")]
        [SerializeField] private Color courtColor = new Color(0.83f, 0.53f, 0.31f);
        [SerializeField] private Color lineColor = new Color(0.95f, 0.92f, 0.86f);
        [SerializeField] private Color ballColor = new Color(0.93f, 0.45f, 0.16f);
        [SerializeField] private Color rimColor = new Color(0.90f, 0.24f, 0.16f);
        [SerializeField] private Color boardColor = new Color(0.96f, 0.96f, 0.96f);
        [SerializeField] private Color netColor = new Color(0.88f, 0.88f, 0.90f);

        private Transform _root;
        private GameObject _ball;
        private GameObject _ghost;
        private GameObject _rimLeft;
        private GameObject _rimRight;
        private GameObject _net;
        private GameObject _board;
        private GameObject _floor;
        private GameObject _target;
        private GameObject _rim;
        private GameObject _post;
        private GameObject _arm;

        /// <summary>World units per sub-unit. The sim's court is 9x16 sub-thousands.</summary>
        private const float Scale = 1f / Sim.Sub;

        private void Awake()
        {
            _root = new GameObject("PopShotWorld").transform;
            _root.SetParent(transform, false);

            _floor = Build("Floor", courtColor);
            // The ring itself, spanning the two posts.
            //
            // Without it the hoop is two small red squares with a gap between
            // them, which reads as two markers rather than as a basket — the eye
            // needs the bar to close the shape. Seen edge-on from a 2D camera a
            // ring IS a bar, so this is both correct and free.
            _rim = Build("Rim", rimColor);

            // A stanchion, so the hoop is MOUNTED rather than floating.
            //
            // This replaces a painted target square on the backboard, which was
            // a mistake I could only see once it was on screen: the camera looks
            // straight down the court's depth axis, so the backboard is edge-on
            // and its face — and anything painted on it — is invisible by
            // construction. A square that cannot be seen is not detail, it is
            // three wasted draw calls and one stray red stripe where a bar
            // happened to catch the light.
            //
            // What the eye actually wanted was for the hoop to be attached to
            // something.
            _post = Build("Stanchion", new Color(0.42f, 0.45f, 0.52f));
            _arm = Build("Arm", new Color(0.42f, 0.45f, 0.52f));
            _board = Build("Backboard", boardColor);
            _rimLeft = Build("RimLeft", rimColor);
            _rimRight = Build("RimRight", rimColor);
            _net = BuildAssembly("Net", t => Props.BuildNet(t, boardMaterial, netColor, 1f));
            // A basketball, not an orange dot: sphere plus seams. Without them
            // the ball has no surface detail at all, so its bounce and travel
            // read as a sliding disc rather than a rolling object.
            _ball = BuildAssembly("Ball", t => Props.BuildBasketball(t, boardMaterial, ballColor));
            _ghost = BuildAssembly("BallWrapped",
                t => Props.BuildBasketball(t, boardMaterial, ballColor));

            // A court line, purely so the eye has something to measure the ball
            // against. Without it the ball appears to hang in a void.
            var line = Build("BaseLine", lineColor);
            line.transform.localScale = new Vector3(Sim.CourtW * Scale, 0.06f, 0.1f);
            line.transform.localPosition = new Vector3(
                Sim.CourtW * Scale * 0.5f, Sim.FloorY * Scale - 0.34f, 0.05f);
        }

        private GameObject Build(string name, Color color)
        {
            // PrimitiveMesh, not GameObject.CreatePrimitive: the Physics module is
            // stripped from player builds and CreatePrimitive attaches a collider.
            // See PrimitiveMesh for the crash this avoids.
            var go = PrimitiveMesh.CubeObject(name, boardMaterial);
            go.transform.SetParent(_root, false);
            Tint(go, color);
            return go;
        }

        /// <summary>An empty parent holding a composite prop, scaled like a cube.</summary>
        private GameObject BuildAssembly(string name, System.Action<Transform> build)
        {
            var go = new GameObject(name);
            go.transform.SetParent(_root, false);
            build(go.transform);
            return go;
        }

        private static void Tint(GameObject go, Color color)
        {
            var r = go.GetComponent<MeshRenderer>();
            var block = new MaterialPropertyBlock();
            r.GetPropertyBlock(block);
            // URP Unlit uses _BaseColor; the built-in fallback uses _Color.
            block.SetColor("_BaseColor", color);
            block.SetColor("_Color", color);
            r.SetPropertyBlock(block);
        }

        private void LateUpdate()
        {
            var state = game != null ? game.State : null;
            if (state == null) return;

            FrameCourt();
            LayoutCourt(state);
            LayoutBall(state);
        }

        /// <summary>
        /// Fit the whole court width on screen.
        ///
        /// orthographicSize is HALF the view HEIGHT, and on a 9:20 phone framing
        /// by height crops the sides: the court is 9 units wide and a 16-unit
        /// view is only 7.2 units across. The first device build lost nearly two
        /// columns off the left, taking most of the floor with them.
        ///
        /// Width is the binding dimension in portrait, so size is derived from it
        /// — the same reasoning as Chicken Run's CameraRig, and re-derived every
        /// frame so a resize cannot crop the court back out of view.
        /// </summary>
        private void FrameCourt()
        {
            if (camera == null) return;

            float aspect = camera.aspect > 0.01f ? camera.aspect : 0.5f;
            float size = (Sim.CourtW * Scale * 0.5f) / aspect;

            // Never smaller than the court is tall, or a very wide screen would
            // crop the hoop off the top instead.
            camera.orthographicSize = Mathf.Max(size, Sim.CourtH * Scale * 0.5f);

            camera.transform.position = new Vector3(
                Sim.CourtW * Scale * 0.5f,
                Sim.CourtH * Scale * 0.5f,
                -20f);
        }

        /// <summary>
        /// The hoop moves with the seed, so the court is laid out per round rather
        /// than once. Cheap, and it means a new seed cannot leave a stale rim.
        /// </summary>
        private void LayoutCourt(Sim.State state)
        {
            float hoopX = state.HoopXPos * Scale;
            float hoopY = Sim.HoopY * Scale;
            float rimHalf = Sim.RimHalf * Scale;
            float postD = Sim.PostR * 2f * Scale;

            // Meets the ball's resting height exactly, so the ball sits ON the
            // floor rather than hovering above a slab.
            float floorTop = Sim.FloorY * Scale - Sim.BallR * Scale;
            _floor.transform.localScale = new Vector3(Sim.CourtW * Scale, 1.2f, 1f);
            _floor.transform.localPosition =
                new Vector3(Sim.CourtW * Scale * 0.5f, floorTop - 0.6f, 0.2f);

            _rimLeft.transform.localScale = new Vector3(postD, postD, postD);
            _rimLeft.transform.localPosition = new Vector3(hoopX - rimHalf, hoopY, 0f);

            _rimRight.transform.localScale = new Vector3(postD, postD, postD);
            _rimRight.transform.localPosition = new Vector3(hoopX + rimHalf, hoopY, 0f);

            // The ring, closing the gap between the posts.
            _rim.transform.localScale = new Vector3(rimHalf * 2f + postD, postD * 0.72f, postD * 0.9f);
            _rim.transform.localPosition = new Vector3(hoopX, hoopY, 0f);

            // The net hangs FROM the ring, so its top edge meets the rim exactly.
            // The first version floated a slab below the hoop with a visible gap,
            // which read as an unrelated object.
            const float netHeight = 0.55f;
            _net.transform.localScale = new Vector3(rimHalf * 1.7f, netHeight, 0.04f);
            _net.transform.localPosition = new Vector3(hoopX, hoopY - netHeight * 0.5f, 0.3f);

            float boardX = Sim.BoardX(state) * Scale;
            _board.transform.localScale =
                new Vector3(Sim.BoardThick * 2f * Scale, Sim.BoardH * Scale, 0.6f);
            _board.transform.localPosition =
                new Vector3(boardX, hoopY + Sim.BoardH * Scale * 0.5f, 0.1f);

            // Stanchion: a pole from the floor up behind the backboard, and a
            // short arm out to it. Two cubes, and the hoop stops floating.
            float poleX = boardX + 0.55f;
            float poleTop = hoopY + Sim.BoardH * Scale * 0.75f;
            _post.transform.localScale = new Vector3(0.16f, poleTop, 0.16f);
            _post.transform.localPosition = new Vector3(poleX, poleTop * 0.5f, 0.15f);

            _arm.transform.localScale = new Vector3(0.62f, 0.12f, 0.12f);
            _arm.transform.localPosition = new Vector3(boardX + 0.28f, hoopY + 0.35f, 0.12f);
        }

        private void LayoutBall(Sim.State state)
        {
            // Interpolate between the last two ticks. The sim is 50Hz; the screen
            // is not, and snapping 50 times a second looks like stutter.
            float a = game.TickAlpha;
            float x = Mathf.Lerp(game.PrevX, state.X, a) * Scale;
            float y = Mathf.Lerp(game.PrevY, state.Y, a) * Scale;

            // A wrap is a discontinuity: interpolating across it would drag the
            // ball backwards through the whole court in one frame.
            if (Mathf.Abs(state.X - game.PrevX) > Sim.CourtW / 2)
            {
                x = state.X * Scale;
                y = state.Y * Scale;
            }

            float d = Sim.BallR * 2f * Scale;
            _ball.transform.localScale = new Vector3(d, d, d);
            _ball.transform.localPosition = new Vector3(x, y, 0f);

            // The wrapped twin, on whichever side the ball is closest to.
            float courtW = Sim.CourtW * Scale;
            float ghostX = x < courtW * 0.5f ? x + courtW : x - courtW;
            _ghost.transform.localScale = _ball.transform.localScale;
            _ghost.transform.localPosition = new Vector3(ghostX, y, 0f);
        }
    }
}
