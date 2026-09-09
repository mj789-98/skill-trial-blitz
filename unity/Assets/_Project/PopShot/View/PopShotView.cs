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

        /// <summary>World units per sub-unit. The sim's court is 9x16 sub-thousands.</summary>
        private const float Scale = 1f / Sim.Sub;

        private void Awake()
        {
            _root = new GameObject("PopShotWorld").transform;
            _root.SetParent(transform, false);

            _floor = Build("Floor", courtColor);
            _board = Build("Backboard", boardColor);
            _rimLeft = Build("RimLeft", rimColor);
            _rimRight = Build("RimRight", rimColor);
            _net = Build("Net", netColor);
            _ball = Build("Ball", ballColor);
            _ghost = Build("BallWrapped", ballColor);

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

            LayoutCourt(state);
            LayoutBall(state);
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

            _floor.transform.localScale = new Vector3(Sim.CourtW * Scale, 0.5f, 1f);
            _floor.transform.localPosition = new Vector3(Sim.CourtW * Scale * 0.5f, -0.25f, 0.2f);

            _rimLeft.transform.localScale = new Vector3(postD, postD, postD);
            _rimLeft.transform.localPosition = new Vector3(hoopX - rimHalf, hoopY, 0f);

            _rimRight.transform.localScale = new Vector3(postD, postD, postD);
            _rimRight.transform.localPosition = new Vector3(hoopX + rimHalf, hoopY, 0f);

            // The net is decoration, and deliberately BEHIND the ball in z so a
            // ball dropping through is drawn in front of it. Nothing in the
            // simulation knows it exists.
            _net.transform.localScale = new Vector3(rimHalf * 2f, 0.55f, 0.05f);
            _net.transform.localPosition = new Vector3(hoopX, hoopY - 0.3f, 0.3f);

            float boardX = Sim.BoardX(state) * Scale;
            _board.transform.localScale =
                new Vector3(Sim.BoardThick * 2f * Scale, Sim.BoardH * Scale, 0.6f);
            _board.transform.localPosition =
                new Vector3(boardX, hoopY + Sim.BoardH * Scale * 0.5f, 0.1f);
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
